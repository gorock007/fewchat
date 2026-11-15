import { and, eq } from "drizzle-orm";

import { decryptToken } from "../crypto/tokens";
import { markNeedsReconnect } from "../db/accounts-write";
import {
  claimDelivery,
  deferDelivery,
  expireDelivery,
  failDelivery,
  finishDelivery,
  type Db,
} from "../db/deliveries";
import {
  appSettings,
  automations,
  deliveries,
  instagramAccounts,
  PENDING_DELIVERY_STATUSES,
} from "../db/schema";
import { checkEligibility } from "../domain/eligibility";
import { computeBackoff, type RateLimitOptions } from "../domain/rate-limit";
import {
  MAX_DM_TEXT_LENGTH,
  renderTemplate,
  validateTemplate,
} from "../domain/template";
import type { createMetaClient } from "../meta/client";

export const MAX_SEND_ATTEMPTS = 5;

export type DeliveryDependencies = {
  db: Db;
  meta: Pick<ReturnType<typeof createMetaClient>, "sendPrivateReply">;
  tokenEncryptionKey: string;
  limits: Required<RateLimitOptions>;
  /** Epoch milliseconds; called again after the HTTP response for persistence/backoff. */
  now: () => number;
  random: () => number;
};

export type ProcessDeliveryResult = (
  | {
      result:
        | "skipped"
        | "paused"
        | "expired"
        | "sent"
        | "unknown"
        | "permanent_failed";
    }
  | { result: "deferred" | "retryable_failed"; retryAt: number }
) & {
  /** Fixed diagnostic for the consumer's single log line; never raw error data. */
  errorClass?: "AccountReconnectWriteError";
};

/** Only this error proves no claim was attempted (or it definitively lost). */
export class BeforeClaimError extends Error {
  constructor() {
    super("Delivery processing failed before claim");
    this.name = "BeforeClaimError";
  }
}

async function prepare(id: string, deps: DeliveryDependencies) {
  try {
    const now = deps.now();
    const [loaded] = await deps.db
      .select({
        delivery: deliveries,
        account: instagramAccounts,
        automation: automations,
        sendsPaused: appSettings.sendsPaused,
      })
      .from(deliveries)
      .innerJoin(
        instagramAccounts,
        eq(deliveries.instagramAccountId, instagramAccounts.id),
      )
      .innerJoin(
        automations,
        and(
          eq(deliveries.automationId, automations.id),
          eq(automations.instagramAccountId, instagramAccounts.id),
        ),
      )
      .leftJoin(appSettings, eq(appSettings.id, 1))
      .where(eq(deliveries.id, id));
    if (
      !loaded ||
      !(PENDING_DELIVERY_STATUSES as readonly string[]).includes(
        loaded.delivery.status,
      )
    ) {
      return { result: "skipped" } as const;
    }
    if (loaded.sendsPaused === null) throw new Error("Missing app settings");
    if (loaded.sendsPaused || loaded.account.connectionStatus !== "connected") {
      return { result: "paused" } as const;
    }
    if (
      typeof deps.tokenEncryptionKey !== "string" ||
      !deps.tokenEncryptionKey.trim()
    ) {
      throw new BeforeClaimError();
    }
    const { delivery, automation } = loaded;
    const expired =
      delivery.commentCreatedAt === null ||
      !checkEligibility(new Date(delivery.commentCreatedAt), new Date(now))
        .eligible;
    if (!automation.isActive || automation.deletedAt !== null || expired) {
      const changed = await expireDelivery(deps.db, {
        id,
        now,
        errorCategory:
          !automation.isActive || automation.deletedAt !== null
            ? "automation_inactive"
            : "comment_expired",
      });
      return { result: changed ? "expired" : "skipped" } as const;
    }
    // Duplicate/early queue messages must respect a persisted backoff.
    if (delivery.nextAttemptAt !== null && delivery.nextAttemptAt > now) {
      return { result: "deferred", retryAt: delivery.nextAttemptAt } as const;
    }
    return { ...loaded, now };
  } catch {
    throw new BeforeClaimError();
  }
}

/** One durable claim, at most one Meta call. Never retry inside this function. */
export async function processDelivery(
  id: string,
  deps: DeliveryDependencies,
): Promise<ProcessDeliveryResult> {
  const prepared = await prepare(id, deps);
  if (prepared.result !== undefined) return prepared;
  const { account, automation } = prepared;
  const claim = await claimDelivery(deps.db, {
    id,
    now: prepared.now,
    limits: deps.limits,
  });
  // An exception from the claim is ambiguous: D1 may have committed it. Leave
  // that exception untouched, just like delivery-result persistence failures.
  if (claim.outcome === "unavailable") return { result: "skipped" };
  if (claim.outcome === "rate_limited") {
    try {
      const changed = await deferDelivery(deps.db, {
        id,
        now: prepared.now,
        nextAttemptAt: claim.retryAt,
      });
      return changed
        ? { result: "deferred", retryAt: claim.retryAt }
        : { result: "skipped" };
    } catch {
      throw new BeforeClaimError();
    }
  }

  const permanentlyFail = async (
    errorCategory: string,
  ): Promise<ProcessDeliveryResult> => {
    const changed = await failDelivery(deps.db, {
      id,
      now: deps.now(),
      status: "PERMANENT_FAILED",
      errorCategory,
    });
    return { result: changed ? "permanent_failed" : "skipped" };
  };

  // The delivery outcome is durable before this best-effort account update.
  // A reconnect racing this attempt must not be overwritten by stale credentials.
  const reconnectAfter = async (
    result: ProcessDeliveryResult,
  ): Promise<ProcessDeliveryResult> => {
    try {
      await markNeedsReconnect(
        deps.db,
        account.id,
        deps.now(),
        account.encryptedAccessToken,
      );
      return result;
    } catch {
      return { ...result, errorClass: "AccountReconnectWriteError" };
    }
  };

  let accessToken: string;
  try {
    accessToken = await decryptToken(account.encryptedAccessToken ?? "", {
      encryptionKey: deps.tokenEncryptionKey,
      instagramAccountId: account.id,
    });
  } catch {
    return reconnectAfter(await permanentlyFail("token_decrypt_failed"));
  }

  let text: string;
  try {
    const values = {
      username: claim.delivery.commenterUsername ?? "",
      keyword: automation.keyword,
      resourceUrl: automation.resourceUrl,
    };
    if (!validateTemplate(automation.dmTemplate, values).ok)
      throw new Error("Invalid template");
    text = renderTemplate(automation.dmTemplate, values);
    // The domain currently checks character length; Meta's limit is bytes.
    if (!text || new TextEncoder().encode(text).length > MAX_DM_TEXT_LENGTH)
      throw new Error("Invalid rendered message");
  } catch {
    return permanentlyFail("template_invalid");
  }

  const outcome = await deps.meta.sendPrivateReply({
    accountId: account.instagramUserId,
    commentId: claim.delivery.commentId,
    text,
    accessToken,
  });
  const now = deps.now();
  if (outcome.kind === "sent" && "message_id" in outcome.ids) {
    const changed = await finishDelivery(deps.db, {
      id,
      now,
      metaMessageId: outcome.ids.message_id,
      metaRecipientId: outcome.ids.recipient_id,
    });
    return { result: changed ? "sent" : "skipped" };
  }
  // A public-reply-shaped success cannot establish a private send's IDs.
  if (outcome.kind === "unknown" || outcome.kind === "sent") {
    const changed = await failDelivery(deps.db, {
      id,
      now,
      status: "DELIVERY_UNKNOWN",
      errorCategory: "unknown",
    });
    return { result: changed ? "unknown" : "skipped" };
  }
  const needsReconnect =
    outcome.kind === "token_invalid" || outcome.kind === "permission_denied";
  if (
    outcome.kind === "ineligible" ||
    outcome.kind === "policy_blocked" ||
    outcome.kind === "invalid_request" ||
    claim.delivery.attemptCount >= MAX_SEND_ATTEMPTS
  ) {
    const result = await permanentlyFail(outcome.kind);
    return needsReconnect ? reconnectAfter(result) : result;
  }
  // Eligibility is rechecked before the next claim. This preserves the ruled
  // retryable outcome even when Retry-After extends beyond the reply window.
  const retryAt = computeBackoff(claim.delivery.attemptCount, {
    now: new Date(now),
    random: deps.random,
    retryAfterMs:
      outcome.kind === "rate_limited" ? outcome.retryAfterMs : undefined,
  })!.getTime();
  const changed = await failDelivery(deps.db, {
    id,
    now,
    status: "RETRYABLE_FAILED",
    nextAttemptAt: retryAt,
    errorCategory: outcome.kind,
    errorCode: outcome.code === null ? undefined : String(outcome.code),
  });
  const result: ProcessDeliveryResult = changed
    ? { result: "retryable_failed", retryAt }
    : { result: "skipped" };
  return needsReconnect ? reconnectAfter(result) : result;
}
