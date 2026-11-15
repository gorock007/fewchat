import { and, asc, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";

import { decryptToken, encryptToken } from "../crypto/tokens";
import {
  markNeedsReconnect,
  saveRefreshedToken,
  stampTokenRefreshAttempt,
} from "../db/accounts-write";
import { instagramAccounts } from "../db/schema";
import type { DeliveryDependencies } from "../delivery/process";
import type { createMetaClient } from "../meta/client";

const HOUR = 60 * 60 * 1000;

/** Refresh a token once it has under this long left (meta-api.md §2.2). */
export const REFRESH_WINDOW_MS = 7 * 24 * HOUR;
/** Meta refuses a token younger than this. */
export const REFRESH_MIN_AGE_MS = 24 * HOUR;
/** After an attempt, however it ended, wait this long before the next. */
export const REFRESH_RETRY_MS = HOUR;

export type RefreshDependencies = Pick<
  DeliveryDependencies,
  "db" | "tokenEncryptionKey" | "now"
> & { meta: Pick<ReturnType<typeof createMetaClient>, "refreshToken"> };

export type RefreshResult = "none" | "refreshed" | "failed" | "skipped";

/**
 * Refresh at most one connected account's long-lived token that is due: under
 * seven days left, at least a day since it was issued, and no attempt in the
 * last hour. A null `token_refreshed_at` (an account not written by the seed)
 * counts as old enough: under seven days left already means weeks of age.
 *
 * The attempt is stamped before Meta is called, so a failing account is retried
 * hourly rather than on every tick. Every write is conditional on the
 * ciphertext that was read, so a reconnect in between always wins. The token
 * is never logged and Meta's failure text is not kept.
 */
export async function refreshDueToken(
  deps: RefreshDependencies,
  { now }: { now: number },
): Promise<RefreshResult> {
  const [account] = await deps.db
    .select({
      id: instagramAccounts.id,
      encryptedAccessToken: instagramAccounts.encryptedAccessToken,
    })
    .from(instagramAccounts)
    .where(
      and(
        eq(instagramAccounts.connectionStatus, "connected"),
        isNotNull(instagramAccounts.encryptedAccessToken),
        lt(instagramAccounts.tokenExpiresAt, now + REFRESH_WINDOW_MS),
        or(
          isNull(instagramAccounts.tokenRefreshedAt),
          lte(instagramAccounts.tokenRefreshedAt, now - REFRESH_MIN_AGE_MS),
        ),
        or(
          isNull(instagramAccounts.tokenRefreshAttemptedAt),
          lte(
            instagramAccounts.tokenRefreshAttemptedAt,
            now - REFRESH_RETRY_MS,
          ),
        ),
      ),
    )
    .orderBy(asc(instagramAccounts.tokenExpiresAt))
    .limit(1);
  if (!account?.encryptedAccessToken) return "none";
  const { id, encryptedAccessToken } = account;

  if (!(await stampTokenRefreshAttempt(deps.db, id, now, encryptedAccessToken)))
    return "skipped";

  let token: string;
  try {
    token = await decryptToken(encryptedAccessToken, {
      encryptionKey: deps.tokenEncryptionKey,
      instagramAccountId: id,
    });
  } catch {
    // Same ruling as a send: a token that cannot be decrypted is unusable.
    await markNeedsReconnect(deps.db, id, now, encryptedAccessToken);
    return "failed";
  }

  const outcome = await deps.meta.refreshToken(token);
  if (outcome.kind === "ok") {
    const refreshedAt = deps.now();
    const saved = await saveRefreshedToken(deps.db, {
      accountId: id,
      now: refreshedAt,
      previousEncryptedAccessToken: encryptedAccessToken,
      encryptedAccessToken: await encryptToken(outcome.data.access_token, {
        encryptionKey: deps.tokenEncryptionKey,
        instagramAccountId: id,
      }),
      tokenExpiresAt: refreshedAt + outcome.data.expires_in * 1000,
    });
    return saved ? "refreshed" : "skipped";
  }
  if (
    outcome.kind === "token_invalid" ||
    outcome.kind === "permission_denied"
  ) {
    await markNeedsReconnect(deps.db, id, deps.now(), encryptedAccessToken);
  }
  // Anything else (rate limit, 5xx, transport): left for the hourly retry.
  return "failed";
}
