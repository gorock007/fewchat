// Drizzle schema (SQLite dialect, for D1) for docs/PRD.md §9, ported from the
// archived Postgres design (ADR 0002, "What ports from
// archive/postgres-schema-queue"). Field names follow the PRD; extra columns
// are noted where they appear. Every row that belongs to an account keeps an
// `instagram_account_id` FK so multi-account stays possible later.
//
// SQLite translations: IDs are app-generated text (`crypto.randomUUID()`),
// timestamps are integer epoch milliseconds, enums are text plus an explicit
// CHECK (Drizzle's `enum` option only types them), JSON is text.
// Indexes count toward D1's 100,000 rows written per day, so each one here
// has a reader; see src/db/README.md for what was dropped.
import { sql, type SQL } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
const epochMs = (name: string) => integer(name);
const createdAt = () =>
  epochMs("created_at")
    .notNull()
    .$defaultFn(() => Date.now());
const updatedAt = () =>
  epochMs("updated_at")
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());
const flag = (name: string) => integer(name, { mode: "boolean" });

/**
 * `column in ('a', 'b', …)` with the values inlined: for the CHECK that backs
 * a text enum, and for status predicates that must match a partial index's
 * WHERE (SQLite cannot use a partial index for a bound parameter).
 */
export function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

// ---------------------------------------------------------------- enums

export const CONNECTION_STATUSES = [
  "connected",
  // Token expired, revoked or missing a permission: sends stop until the
  // admin reconnects (PRD §10.2, §10.3).
  "needs_reconnect",
  "disconnected",
] as const;

export const WEBHOOK_SUBSCRIPTION_STATUSES = [
  "unknown",
  "subscribed",
  "failed",
  "unsubscribed",
] as const;

export const TRIGGER_TYPES = ["keyword", "any"] as const;

export const MATCH_MODES = ["exact", "whole_word", "contains"] as const;

export const WEBHOOK_PROCESSING_STATUSES = [
  "pending",
  "processed",
  "ignored",
  "failed",
] as const;

/** FR-08. SENT means Meta acknowledged the request, not that it was read. */
export const DELIVERY_STATUSES = [
  "RECEIVED",
  "SKIPPED",
  "QUEUED",
  "SENDING",
  "SENT",
  "RETRYABLE_FAILED",
  "PERMANENT_FAILED",
  // The request may have reached Meta; never resent automatically.
  "DELIVERY_UNKNOWN",
  "EXPIRED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Waiting for a send: what the sweep picks up and the claim accepts. */
export const PENDING_DELIVERY_STATUSES = [
  "QUEUED",
  "RETRYABLE_FAILED",
] as const satisfies readonly DeliveryStatus[];

/** Claimed sends that may have reached Meta: they count toward the rate limit. */
export const RATE_COUNTED_DELIVERY_STATUSES = [
  "SENDING",
  "SENT",
  "DELIVERY_UNKNOWN",
] as const satisfies readonly DeliveryStatus[];

export const PUBLIC_REPLY_STATUSES = [
  "not_requested",
  "pending",
  "sent",
  "failed",
] as const;

export const DELIVERY_SOURCES = [
  "webhook",
  "reconciliation",
  "manual",
] as const;

export const EVENT_SEVERITIES = ["info", "warning", "error"] as const;

// ---------------------------------------------------------------- tables

export const instagramAccounts = sqliteTable(
  "instagram_accounts",
  {
    id: id(),
    instagramUserId: text("instagram_user_id").notNull().unique(),
    username: text("username").notNull(),
    accountType: text("account_type"),
    // Ciphertext only; the plaintext token is never stored.
    encryptedAccessToken: text("encrypted_access_token"),
    tokenExpiresAt: epochMs("token_expires_at"),
    // Daily refresh (src/worker/refresh.ts). `token_refreshed_at` is when the
    // stored token was issued or last refreshed; the attempted column paces
    // retries after a failed refresh.
    tokenRefreshedAt: epochMs("token_refreshed_at"),
    tokenRefreshAttemptedAt: epochMs("token_refresh_attempted_at"),
    connectionStatus: text("connection_status", { enum: CONNECTION_STATUSES })
      .notNull()
      .default("connected"),
    webhookSubscriptionStatus: text("webhook_subscription_status", {
      enum: WEBHOOK_SUBSCRIPTION_STATUSES,
    })
      .notNull()
      .default("unknown"),
    lastConnectedAt: epochMs("last_connected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "instagram_accounts_connection_status",
      oneOf(t.connectionStatus, CONNECTION_STATUSES),
    ),
    check(
      "instagram_accounts_webhook_subscription_status",
      oneOf(t.webhookSubscriptionStatus, WEBHOOK_SUBSCRIPTION_STATUSES),
    ),
  ],
);

export const automations = sqliteTable(
  "automations",
  {
    id: id(),
    instagramAccountId: text("instagram_account_id")
      .notNull()
      .references(() => instagramAccounts.id),
    name: text("name").notNull(),
    mediaId: text("media_id").notNull(),
    mediaType: text("media_type"),
    triggerType: text("trigger_type", { enum: TRIGGER_TYPES }).notNull(),
    keyword: text("keyword"),
    matchMode: text("match_mode", { enum: MATCH_MODES }),
    dmTemplate: text("dm_template").notNull(),
    resourceUrl: text("resource_url").notNull(),
    publicReplyEnabled: flag("public_reply_enabled").notNull().default(false),
    publicReplyTemplate: text("public_reply_template"),
    oncePerUser: flag("once_per_user").notNull().default(true),
    isActive: flag("is_active").notNull().default(true),
    // Not in PRD §9: deleting an automation is a soft delete so its delivery
    // history stays intact (FR-03). A deleted automation is never active.
    deletedAt: epochMs("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FR-03: only one active automation per media item. Also the webhook's
    // lookup from (account, media) to its automation.
    uniqueIndex("automations_one_active_per_media")
      .on(t.instagramAccountId, t.mediaId)
      .where(sql`${t.isActive} = 1`),
    check("automations_trigger_type", oneOf(t.triggerType, TRIGGER_TYPES)),
    check(
      "automations_match_mode",
      sql`${t.matchMode} is null or ${oneOf(t.matchMode, MATCH_MODES)}`,
    ),
    check(
      "automations_keyword_trigger_has_keyword",
      sql`${t.triggerType} <> 'keyword' or (${t.keyword} is not null and ${t.matchMode} is not null)`,
    ),
    check(
      "automations_deleted_is_inactive",
      sql`${t.deletedAt} is null or ${t.isActive} = 0`,
    ),
  ],
);

/** The minimal comment fields matching and recovery need; never a raw body. */
export type WebhookEventPayload = {
  commentId: string;
  mediaId: string;
  text?: string;
  fromId?: string;
  fromUsername?: string;
  parentId?: string;
  createdAt?: string;
};

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: id(),
    // Dedupes a Meta redelivery of the same event.
    eventKey: text("event_key").notNull().unique(),
    eventType: text("event_type").notNull(),
    instagramAccountId: text("instagram_account_id").references(
      () => instagramAccounts.id,
    ),
    payload: text("payload", { mode: "json" }).$type<WebhookEventPayload>(),
    receivedAt: epochMs("received_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    processingStatus: text("processing_status", {
      enum: WEBHOOK_PROCESSING_STATUSES,
    })
      .notNull()
      .default("pending"),
    processedAt: epochMs("processed_at"),
    errorCategory: text("error_category"),
  },
  (t) => [
    check(
      "webhook_events_processing_status",
      oneOf(t.processingStatus, WEBHOOK_PROCESSING_STATUSES),
    ),
  ],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: id(),
    instagramAccountId: text("instagram_account_id")
      .notNull()
      .references(() => instagramAccounts.id),
    automationId: text("automation_id")
      .notNull()
      .references(() => automations.id),
    commentId: text("comment_id").notNull(),
    commenterIgsid: text("commenter_igsid"),
    commenterUsername: text("commenter_username"),
    commentTextExcerpt: text("comment_text_excerpt"),
    commentCreatedAt: epochMs("comment_created_at"),
    source: text("source", { enum: DELIVERY_SOURCES }).notNull(),
    status: text("status", { enum: DELIVERY_STATUSES })
      .notNull()
      .default("RECEIVED"),
    // Not in PRD §9: true on the one delivery that holds this commenter's
    // once-per-user slot for the automation. See the partial index below.
    countsTowardOncePerUser: flag("counts_toward_once_per_user")
      .notNull()
      .default(false),
    // Not in PRD §9: why a SKIPPED delivery was not sent (Activity page).
    skipReason: text("skip_reason"),
    metaMessageId: text("meta_message_id"),
    metaRecipientId: text("meta_recipient_id"),
    publicReplyStatus: text("public_reply_status", {
      enum: PUBLIC_REPLY_STATUSES,
    })
      .notNull()
      .default("not_requested"),
    publicReplyId: text("public_reply_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    // Not in PRD §9 (replaces the archived `jobs.run_after`): when the sweep
    // may next pick up a QUEUED or RETRYABLE_FAILED delivery.
    nextAttemptAt: epochMs("next_attempt_at"),
    // Not in PRD §9 (replaces the archived job lease): when the latest claim
    // moved the delivery to SENDING. Drives the rolling-hour rate limit and
    // stale-SENDING quarantine.
    claimedAt: epochMs("claimed_at"),
    // Not in PRD §9: the Activity page shows an error category (FR-08).
    lastErrorCategory: text("last_error_category"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
    sentAt: epochMs("sent_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FR-06: a comment never yields more than one delivery per account.
    uniqueIndex("deliveries_account_comment_unique").on(
      t.instagramAccountId,
      t.commentId,
    ),
    // FR-06 once-per-user, enforced by the database rather than a
    // read-then-insert check: the delivery that claims a commenter's slot is
    // inserted with counts_toward_once_per_user = 1, and a concurrent or
    // later claim for the same (automation, commenter) fails this index.
    // `recordEventStatements` then records the comment as SKIPPED without
    // the slot, in the same batch. A delivery that ends without being sent
    // (PERMANENT_FAILED, EXPIRED) can release the slot by clearing the flag.
    uniqueIndex("deliveries_once_per_user_unique")
      .on(t.automationId, t.commenterIgsid)
      .where(sql`${t.countsTowardOncePerUser} = 1`),
    // Activity page (newest first, date-range filter) and retention purge.
    // Never updated after insert, so it costs one write per delivery.
    index("deliveries_created_at_idx").on(t.createdAt),
    // The sweep (`pendingDeliveries`). Partial, so a delivery leaves it once
    // claimed and sent rows cost nothing to keep.
    index("deliveries_pending_idx")
      .on(t.nextAttemptAt)
      .where(oneOf(t.status, PENDING_DELIVERY_STATUSES)),
    // Stale-SENDING quarantine. Holds only in-flight rows.
    index("deliveries_sending_idx")
      .on(t.claimedAt)
      .where(oneOf(t.status, ["SENDING"])),
    // Rolling-hour limit in `claimDelivery`: claims per account since a
    // cutoff. claimed_at changes only on a claim, so finishing a send does
    // not touch it; never-claimed (SKIPPED) rows are left out.
    index("deliveries_account_claimed_at_idx")
      .on(t.instagramAccountId, t.claimedAt)
      .where(sql`${t.claimedAt} is not null`),
    check("deliveries_status", oneOf(t.status, DELIVERY_STATUSES)),
    check("deliveries_source", oneOf(t.source, DELIVERY_SOURCES)),
    check(
      "deliveries_public_reply_status",
      oneOf(t.publicReplyStatus, PUBLIC_REPLY_STATUSES),
    ),
    // A pending delivery the sweep cannot see would never be sent.
    check(
      "deliveries_pending_has_next_attempt",
      sql`not (${oneOf(t.status, PENDING_DELIVERY_STATUSES)}) or ${t.nextAttemptAt} is not null`,
    ),
    check(
      "deliveries_sending_has_claimed_at",
      sql`${t.status} <> 'SENDING' or ${t.claimedAt} is not null`,
    ),
  ],
);

export const operationalEvents = sqliteTable(
  "operational_events",
  {
    id: id(),
    severity: text("severity", { enum: EVENT_SEVERITIES }).notNull(),
    category: text("category").notNull(),
    // Must never contain tokens, secrets or raw payloads.
    safeMessage: text("safe_message").notNull(),
    relatedDeliveryId: text("related_delivery_id").references(
      () => deliveries.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
  },
  (t) => [
    // Health page (newest first) and retention purge.
    index("operational_events_created_at_idx").on(t.createdAt),
    // The ON DELETE SET NULL above looks events up by delivery; without this
    // every delivery delete (retention purge) scans the table.
    index("operational_events_related_delivery_idx").on(t.relatedDeliveryId),
    check("operational_events_severity", oneOf(t.severity, EVENT_SEVERITIES)),
  ],
);

/** Single row (id = 1) of app-wide settings and health timestamps. */
export const appSettings = sqliteTable(
  "app_settings",
  {
    id: integer("id").primaryKey().default(1),
    // FR-10 global pause.
    sendsPaused: flag("sends_paused").notNull().default(false),
    // PRD §11.4 commenter-data retention.
    retentionDays: integer("retention_days").notNull().default(30),
    lastWebhookAt: epochMs("last_webhook_at"),
    lastReconciliationAt: epochMs("last_reconciliation_at"),
    // Renamed from the archive's `worker_heartbeat_at`: there is no
    // always-on worker; the cron sweep stamps it.
    lastSweepAt: epochMs("last_sweep_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("app_settings_single_row", sql`${t.id} = 1`),
    check("app_settings_retention_days_positive", sql`${t.retentionDays} > 0`),
  ],
);

// ---------------------------------------------------------------- types

export type InstagramAccount = typeof instagramAccounts.$inferSelect;
export type NewInstagramAccount = typeof instagramAccounts.$inferInsert;
export type Automation = typeof automations.$inferSelect;
export type NewAutomation = typeof automations.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
export type OperationalEvent = typeof operationalEvents.$inferSelect;
export type NewOperationalEvent = typeof operationalEvents.$inferInsert;
export type AppSettings = typeof appSettings.$inferSelect;
