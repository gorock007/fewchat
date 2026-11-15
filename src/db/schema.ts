// Drizzle schema for docs/PRD.md §9. Field names follow the PRD; extra
// columns are noted where they appear. Every row that belongs to an account
// keeps an `instagram_account_id` FK so multi-account stays possible later.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------- enums

export const connectionStatus = pgEnum("connection_status", [
  "connected",
  // Token expired, revoked or missing a permission: sends stop until the
  // admin reconnects (PRD §10.2, §10.3).
  "needs_reconnect",
  "disconnected",
]);

export const webhookSubscriptionStatus = pgEnum("webhook_subscription_status", [
  "unknown",
  "subscribed",
  "failed",
  "unsubscribed",
]);

export const triggerType = pgEnum("trigger_type", ["keyword", "any"]);

export const matchMode = pgEnum("match_mode", [
  "exact",
  "whole_word",
  "contains",
]);

export const webhookProcessingStatus = pgEnum("webhook_processing_status", [
  "pending",
  "processed",
  "ignored",
  "failed",
]);

/** FR-08. SENT means Meta acknowledged the request, not that it was read. */
export const deliveryStatus = pgEnum("delivery_status", [
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
]);

export const publicReplyStatus = pgEnum("public_reply_status", [
  "not_requested",
  "pending",
  "sent",
  "failed",
]);

export const deliverySource = pgEnum("delivery_source", [
  "webhook",
  "reconciliation",
  "manual",
]);

export const jobStatus = pgEnum("job_status", [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
]);

export const eventSeverity = pgEnum("event_severity", [
  "info",
  "warning",
  "error",
]);

// ---------------------------------------------------------------- tables

export const instagramAccounts = pgTable("instagram_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  instagramUserId: text("instagram_user_id").notNull().unique(),
  username: text("username").notNull(),
  accountType: text("account_type"),
  // Ciphertext only; the plaintext token is never stored.
  encryptedAccessToken: text("encrypted_access_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  connectionStatus: connectionStatus("connection_status")
    .notNull()
    .default("connected"),
  webhookSubscriptionStatus: webhookSubscriptionStatus(
    "webhook_subscription_status",
  )
    .notNull()
    .default("unknown"),
  lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const automations = pgTable(
  "automations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instagramAccountId: uuid("instagram_account_id")
      .notNull()
      .references(() => instagramAccounts.id),
    name: text("name").notNull(),
    mediaId: text("media_id").notNull(),
    mediaType: text("media_type"),
    triggerType: triggerType("trigger_type").notNull(),
    keyword: text("keyword"),
    matchMode: matchMode("match_mode"),
    dmTemplate: text("dm_template").notNull(),
    resourceUrl: text("resource_url").notNull(),
    publicReplyEnabled: boolean("public_reply_enabled")
      .notNull()
      .default(false),
    publicReplyTemplate: text("public_reply_template"),
    oncePerUser: boolean("once_per_user").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    // Not in PRD §9: deleting an automation is a soft delete so its delivery
    // history stays intact (FR-03). A deleted automation is never active.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FR-03: only one active automation per media item.
    uniqueIndex("automations_one_active_per_media")
      .on(t.instagramAccountId, t.mediaId)
      .where(sql`${t.isActive}`),
    check(
      "automations_keyword_trigger_has_keyword",
      sql`${t.triggerType} <> 'keyword' or (${t.keyword} is not null and ${t.matchMode} is not null)`,
    ),
    check(
      "automations_deleted_is_inactive",
      sql`${t.deletedAt} is null or not ${t.isActive}`,
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

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull().unique(),
    eventType: text("event_type").notNull(),
    instagramAccountId: uuid("instagram_account_id").references(
      () => instagramAccounts.id,
    ),
    payload: jsonb("payload").$type<WebhookEventPayload>(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    processingStatus: webhookProcessingStatus("processing_status")
      .notNull()
      .default("pending"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    errorCategory: text("error_category"),
  },
  (t) => [index("webhook_events_processing_status_idx").on(t.processingStatus)],
);

export const deliveries = pgTable(
  "deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instagramAccountId: uuid("instagram_account_id")
      .notNull()
      .references(() => instagramAccounts.id),
    automationId: uuid("automation_id")
      .notNull()
      .references(() => automations.id),
    commentId: text("comment_id").notNull(),
    commenterIgsid: text("commenter_igsid"),
    commenterUsername: text("commenter_username"),
    commentTextExcerpt: text("comment_text_excerpt"),
    commentCreatedAt: timestamp("comment_created_at", { withTimezone: true }),
    source: deliverySource("source").notNull(),
    status: deliveryStatus("status").notNull().default("RECEIVED"),
    // Not in PRD §9: true on the one delivery that holds this commenter's
    // once-per-user slot for the automation. See the partial index below.
    countsTowardOncePerUser: boolean("counts_toward_once_per_user")
      .notNull()
      .default(false),
    metaMessageId: text("meta_message_id"),
    metaRecipientId: text("meta_recipient_id"),
    publicReplyStatus: publicReplyStatus("public_reply_status")
      .notNull()
      .default("not_requested"),
    publicReplyId: text("public_reply_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    // Not in PRD §9: the Activity page shows an error category (FR-08).
    lastErrorCategory: text("last_error_category"),
    lastErrorCode: text("last_error_code"),
    lastErrorMessage: text("last_error_message"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    // FR-06: a comment never yields more than one delivery per account.
    uniqueIndex("deliveries_account_comment_unique").on(
      t.instagramAccountId,
      t.commentId,
    ),
    index("deliveries_automation_status_idx").on(t.automationId, t.status),
    index("deliveries_comment_created_at_idx").on(t.commentCreatedAt),
    index("deliveries_automation_commenter_idx").on(
      t.automationId,
      t.commenterIgsid,
    ),
    // FR-06 once-per-user, enforced by the database rather than a
    // read-then-insert check: the delivery that claims a commenter's slot is
    // inserted with counts_toward_once_per_user = true, and a concurrent or
    // later claim for the same (automation, commenter) fails this index
    // inside the same transaction. The caller then inserts the comment as
    // SKIPPED with the flag false. A delivery that ends without being sent
    // (PERMANENT_FAILED, EXPIRED) can release the slot by clearing the flag.
    uniqueIndex("deliveries_once_per_user_unique")
      .on(t.automationId, t.commenterIgsid)
      .where(sql`${t.countsTowardOncePerUser}`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobType: text("job_type").notNull(),
    deliveryId: uuid("delivery_id").references(() => deliveries.id, {
      onDelete: "cascade",
    }),
    status: jobStatus("status").notNull().default("pending"),
    runAfter: timestamp("run_after", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One job of each type per delivery, so repeated enqueues are no-ops.
    uniqueIndex("jobs_type_delivery_unique").on(t.jobType, t.deliveryId),
    index("jobs_status_run_after_idx").on(t.status, t.runAfter),
  ],
);

export const operationalEvents = pgTable(
  "operational_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    severity: eventSeverity("severity").notNull(),
    category: text("category").notNull(),
    // Must never contain tokens, secrets or raw payloads.
    safeMessage: text("safe_message").notNull(),
    relatedDeliveryId: uuid("related_delivery_id").references(
      () => deliveries.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
  },
  (t) => [index("operational_events_created_at_idx").on(t.createdAt)],
);

/** Single row (id = 1) of app-wide settings and health timestamps. */
export const appSettings = pgTable(
  "app_settings",
  {
    id: integer("id").primaryKey().default(1),
    // FR-10 global pause.
    sendsPaused: boolean("sends_paused").notNull().default(false),
    // PRD §11.4 commenter-data retention.
    retentionDays: integer("retention_days").notNull().default(30),
    lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
    lastReconciliationAt: timestamp("last_reconciliation_at", {
      withTimezone: true,
    }),
    workerHeartbeatAt: timestamp("worker_heartbeat_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("app_settings_single_row", sql`${t.id} = 1`),
    check("app_settings_retention_days_positive", sql`${t.retentionDays} > 0`),
  ],
);
