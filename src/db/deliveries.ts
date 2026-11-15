// Delivery state transitions (ADR 0002, Decision 3). D1 is the source of
// truth; the queue and the cron sweep only carry delivery IDs. Every
// transition is one conditional statement on the current status, so two
// callers racing on the same row get one winner and nothing reads then
// writes. The state machine is in src/db/README.md.
import { and, asc, eq, gt, inArray, lt, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { alias } from "drizzle-orm/sqlite-core";

import { decideSend } from "../domain/rate-limit";
import type * as schema from "./schema";
import {
  deliveries,
  oneOf,
  PENDING_DELIVERY_STATUSES,
  RATE_COUNTED_DELIVERY_STATUSES,
  webhookEvents,
  type Delivery,
  type DeliveryStatus,
  type NewDelivery,
  type NewWebhookEvent,
} from "./schema";

// Literal, so the sweep and quarantine use their partial indexes.
const isPending = oneOf(deliveries.status, PENDING_DELIVERY_STATUSES);
const isSending = oneOf(deliveries.status, ["SENDING"]);
// A sender that outlived the stale-SENDING quarantine may still learn the outcome.
const isFinishable = oneOf(deliveries.status, ["SENDING", "DELIVERY_UNKNOWN"]);

/**
 * What `getDb` returns. Spelled out rather than imported from ./client, which
 * needs the Workers types that the root tsconfig (which also checks this file) lacks.
 */
export type Db = DrizzleD1Database<typeof schema>;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Default age after which a SENDING claim is presumed abandoned (gate 6). */
export const STALE_SENDING_MS = 60 * 1000;

/** `skip_reason` of a comment whose commenter already holds the once-per-user slot. */
export const SKIP_ONCE_PER_USER = "once_per_user";

// ---------------------------------------------------------------- ingress

export type RecordEventInput = {
  event: Pick<
    NewWebhookEvent,
    | "eventKey"
    | "eventType"
    | "instagramAccountId"
    | "payload"
    | "processingStatus"
    | "processedAt"
  > & { receivedAt: number };
  /** Omitted when the comment matched no automation. */
  delivery?: Pick<
    NewDelivery,
    | "instagramAccountId"
    | "automationId"
    | "commentId"
    | "commenterIgsid"
    | "commenterUsername"
    | "commentTextExcerpt"
    | "commentCreatedAt"
    | "source"
    | "skipReason"
  > & {
    status: "QUEUED" | "SKIPPED" | "RECEIVED";
    /** The automation's once-per-user setting. Only a QUEUED delivery takes the slot. */
    oncePerUser: boolean;
  };
};

type Statement = BatchItem<"sqlite">;

/**
 * The statements that record one webhook event and its delivery, for the
 * caller to run in one `db.batch` (with other comments' statements) before
 * acknowledging the webhook. A Meta redelivery is a no-op: the event key and
 * the (account, comment) unique swallow it.
 *
 * When a QUEUED delivery takes the commenter's once-per-user slot and the slot
 * is already held, the first delivery insert is dropped and the second records
 * the comment as SKIPPED instead, so the check is the unique index itself.
 */
export function recordEventStatements(
  db: Db,
  { event, delivery }: RecordEventInput,
): [Statement, ...Statement[]] {
  const eventInsert = db
    .insert(webhookEvents)
    .values({
      ...event,
      processingStatus: event.processingStatus ?? "processed",
      processedAt: event.processedAt ?? event.receivedAt,
    })
    .onConflictDoNothing({ target: webhookEvents.eventKey })
    .returning({ id: webhookEvents.id });
  if (!delivery) return [eventInsert];

  const { status, oncePerUser, ...fields } = delivery;
  const row = {
    ...fields,
    status,
    nextAttemptAt: status === "QUEUED" ? event.receivedAt : null,
    createdAt: event.receivedAt,
    updatedAt: event.receivedAt,
  };
  const returned = { id: deliveries.id, status: deliveries.status };
  const byComment = {
    target: [deliveries.instagramAccountId, deliveries.commentId],
  };

  const takesSlot =
    status === "QUEUED" && oncePerUser && fields.commenterIgsid != null;
  if (!takesSlot) {
    return [
      eventInsert,
      db
        .insert(deliveries)
        .values(row)
        .onConflictDoNothing(byComment)
        .returning(returned),
    ];
  }
  return [
    eventInsert,
    // No conflict target: a duplicate comment and a taken slot both drop it.
    db
      .insert(deliveries)
      .values({ ...row, countsTowardOncePerUser: true })
      .onConflictDoNothing()
      .returning(returned),
    // Inserts only when the row above was dropped for the slot, not the comment.
    db
      .insert(deliveries)
      .values({
        ...row,
        status: "SKIPPED",
        skipReason: SKIP_ONCE_PER_USER,
        nextAttemptAt: null,
      })
      .onConflictDoNothing(byComment)
      .returning(returned),
  ];
}

export type RecordedEvent = {
  /** False when the event key was already recorded (a redelivery). */
  eventInserted: boolean;
  /** The delivery this call created, or undefined if none (no match, or a duplicate comment). */
  delivery?: { id: string; status: DeliveryStatus };
};

/** Runs every input's statements in one atomic `db.batch`. */
export async function recordEvents(
  db: Db,
  inputs: readonly RecordEventInput[],
): Promise<RecordedEvent[]> {
  const groups = inputs.map((input) => recordEventStatements(db, input));
  const statements = groups.flat();
  if (statements.length === 0) return [];
  const results = (await db.batch(
    statements as [Statement, ...Statement[]],
  )) as unknown as { id: string; status?: DeliveryStatus }[][];

  let offset = 0;
  return groups.map((group) => {
    const [eventRows = [], ...deliveryRows] = results.slice(
      offset,
      (offset += group.length),
    );
    const delivery = deliveryRows.flat()[0] as RecordedEvent["delivery"];
    return { eventInserted: eventRows.length > 0, delivery };
  });
}

// ---------------------------------------------------------------- send path

export type ClaimLimits = {
  /** Claims per account in any rolling hour (the domain's `perHour`). */
  perHour: number;
  /** Claims per account in any rolling minute (the domain's `burstPerMinute`). */
  burstPerMinute: number;
};

export type ClaimResult =
  | { outcome: "claimed"; delivery: Delivery }
  /** Still pending, but the account is at its limit until `retryAt` (epoch ms). */
  | { outcome: "rate_limited"; retryAt: number }
  /** Missing, or no longer pending: another caller claimed or finished it. */
  | { outcome: "unavailable"; status: DeliveryStatus | null };

const RECENT = "recent";
const recent = alias(deliveries, RECENT);

/** Claims counted against the outer row's account since `cutoff`. */
function claimsSince(cutoff: number) {
  // An alias in a raw template renders as its bare name, so spell out FROM.
  return sql`(select count(*) from ${deliveries} as ${sql.identifier(RECENT)} where ${recent.instagramAccountId} = ${deliveries.instagramAccountId} and ${recent.claimedAt} > ${cutoff} and ${inArray(recent.status, RATE_COUNTED_DELIVERY_STATUSES)})`;
}

/** The claim alone (`QUEUED`/`RETRYABLE_FAILED` → `SENDING`), as one conditional UPDATE. */
export function claimStatement(
  db: Db,
  id: string,
  now: number,
  limits: ClaimLimits,
) {
  return db
    .update(deliveries)
    .set({
      status: "SENDING",
      claimedAt: now,
      attemptCount: sql`${deliveries.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(deliveries.id, id),
        isPending,
        sql`${claimsSince(now - HOUR_MS)} < ${limits.perHour}`,
        sql`${claimsSince(now - MINUTE_MS)} < ${limits.burstPerMinute}`,
      ),
    )
    .returning();
}

/**
 * Claims a delivery for sending. The rolling-hour and per-minute limits are
 * checked inside the same UPDATE, so concurrent claims cannot overshoot them.
 * When the claim does nothing, a follow-up read says whether the row was
 * taken or the account is at its limit, and until when.
 */
export async function claimDelivery(
  db: Db,
  input: { id: string; now: number; limits: ClaimLimits },
): Promise<ClaimResult> {
  const [claimed] = await claimStatement(db, input.id, input.now, input.limits);
  if (claimed) return { outcome: "claimed", delivery: claimed };

  const [row] = await db
    .select({
      status: deliveries.status,
      instagramAccountId: deliveries.instagramAccountId,
    })
    .from(deliveries)
    .where(eq(deliveries.id, input.id));
  if (
    !row ||
    !(PENDING_DELIVERY_STATUSES as readonly string[]).includes(row.status)
  ) {
    return { outcome: "unavailable", status: row?.status ?? null };
  }

  const claims = await db
    .select({ claimedAt: deliveries.claimedAt })
    .from(deliveries)
    .where(
      and(
        eq(deliveries.instagramAccountId, row.instagramAccountId),
        gt(deliveries.claimedAt, input.now - HOUR_MS),
        inArray(deliveries.status, RATE_COUNTED_DELIVERY_STATUSES),
      ),
    );
  const decision = decideSend(
    claims.map((c) => c.claimedAt!),
    new Date(input.now),
    input.limits,
  );
  // Allowed here means a slot freed up between the two statements: retry now.
  const retryAt = decision.allowed ? input.now : decision.retryAt.getTime();
  return { outcome: "rate_limited", retryAt };
}

/**
 * `SENDING` | `DELIVERY_UNKNOWN` → `SENT`: Meta acknowledged the send, even if
 * the claim was quarantined meanwhile. False if the delivery was in neither.
 */
export async function finishDelivery(
  db: Db,
  input: {
    id: string;
    now: number;
    metaMessageId: string;
    metaRecipientId?: string;
  },
): Promise<boolean> {
  const rows = await db
    .update(deliveries)
    .set({
      status: "SENT",
      metaMessageId: input.metaMessageId,
      metaRecipientId: input.metaRecipientId ?? null,
      sentAt: input.now,
      updatedAt: input.now,
    })
    .where(and(eq(deliveries.id, input.id), isFinishable))
    .returning({ id: deliveries.id });
  return rows.length > 0;
}

type FailureFields = {
  id: string;
  now: number;
  errorCategory: string;
  errorCode?: string;
  /** Shown on the Activity page: never a token, secret or raw payload. */
  errorMessage?: string;
};

export type DeliveryFailure = FailureFields &
  (
    | { status: "RETRYABLE_FAILED"; nextAttemptAt: number }
    // DELIVERY_UNKNOWN: the request may have reached Meta. Nothing re-sends it.
    | { status: "PERMANENT_FAILED" | "DELIVERY_UNKNOWN" }
  );

/** `SENDING` → a failure state. False if the delivery was not in `SENDING`. */
export async function failDelivery(
  db: Db,
  input: DeliveryFailure,
): Promise<boolean> {
  const rows = await db
    .update(deliveries)
    .set({
      status: input.status,
      nextAttemptAt:
        input.status === "RETRYABLE_FAILED" ? input.nextAttemptAt : null,
      lastErrorCategory: input.errorCategory,
      lastErrorCode: input.errorCode ?? null,
      lastErrorMessage: input.errorMessage ?? null,
      updatedAt: input.now,
    })
    .where(and(eq(deliveries.id, input.id), isSending))
    .returning({ id: deliveries.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------- sweep

/** `last_error_category` of a delivery quarantined by `quarantineStaleSending`. */
export const STALE_SENDING_CATEGORY = "stale_sending";

/** The quarantine alone: up to `limit` stale `SENDING` rows → `DELIVERY_UNKNOWN`. */
export function quarantineStatement(
  db: Db,
  input: { now: number; olderThanMs?: number; limit?: number },
) {
  const stale = and(
    isSending,
    lt(
      deliveries.claimedAt,
      input.now - (input.olderThanMs ?? STALE_SENDING_MS),
    ),
  );
  const batch = db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(stale)
    .orderBy(asc(deliveries.claimedAt))
    .limit(input.limit ?? 25);
  return db
    .update(deliveries)
    .set({
      status: "DELIVERY_UNKNOWN",
      lastErrorCategory: STALE_SENDING_CATEGORY,
      updatedAt: input.now,
    })
    .where(and(stale, inArray(deliveries.id, batch)))
    .returning({ id: deliveries.id });
}

/**
 * Moves up to `limit` (default 25) `SENDING` deliveries claimed more than
 * `olderThanMs` (default 60 s) ago to `DELIVERY_UNKNOWN`: the claim may
 * already have reached Meta, so they are never reset to `QUEUED`. Returns the
 * quarantined IDs.
 */
export async function quarantineStaleSending(
  db: Db,
  input: { now: number; olderThanMs?: number; limit?: number },
): Promise<string[]> {
  const rows = await quarantineStatement(db, input);
  return rows.map((row) => row.id);
}

/**
 * Pending deliveries due by `now`, earliest `next_attempt_at` first, for the
 * sweep to enqueue. Returns the query; await it.
 */
export function pendingDeliveries(
  db: Db,
  input: { now: number; limit: number },
) {
  return db
    .select({
      id: deliveries.id,
      status: deliveries.status,
      nextAttemptAt: deliveries.nextAttemptAt,
      attemptCount: deliveries.attemptCount,
    })
    .from(deliveries)
    .where(and(isPending, lte(deliveries.nextAttemptAt, input.now)))
    .orderBy(asc(deliveries.nextAttemptAt))
    .limit(input.limit);
}
