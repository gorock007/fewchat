CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`sends_paused` integer DEFAULT false NOT NULL,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`last_webhook_at` integer,
	`last_reconciliation_at` integer,
	`last_sweep_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK("app_settings"."id" = 1),
	CONSTRAINT "app_settings_retention_days_positive" CHECK("app_settings"."retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE `automations` (
	`id` text PRIMARY KEY NOT NULL,
	`instagram_account_id` text NOT NULL,
	`name` text NOT NULL,
	`media_id` text NOT NULL,
	`media_type` text,
	`trigger_type` text NOT NULL,
	`keyword` text,
	`match_mode` text,
	`dm_template` text NOT NULL,
	`resource_url` text NOT NULL,
	`public_reply_enabled` integer DEFAULT false NOT NULL,
	`public_reply_template` text,
	`once_per_user` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instagram_account_id`) REFERENCES `instagram_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "automations_trigger_type" CHECK("automations"."trigger_type" in ('keyword', 'any')),
	CONSTRAINT "automations_match_mode" CHECK("automations"."match_mode" is null or "automations"."match_mode" in ('exact', 'whole_word', 'contains')),
	CONSTRAINT "automations_keyword_trigger_has_keyword" CHECK("automations"."trigger_type" <> 'keyword' or ("automations"."keyword" is not null and "automations"."match_mode" is not null)),
	CONSTRAINT "automations_deleted_is_inactive" CHECK("automations"."deleted_at" is null or "automations"."is_active" = 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automations_one_active_per_media` ON `automations` (`instagram_account_id`,`media_id`) WHERE "automations"."is_active" = 1;--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`instagram_account_id` text NOT NULL,
	`automation_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`commenter_igsid` text,
	`commenter_username` text,
	`comment_text_excerpt` text,
	`comment_created_at` integer,
	`source` text NOT NULL,
	`status` text DEFAULT 'RECEIVED' NOT NULL,
	`counts_toward_once_per_user` integer DEFAULT false NOT NULL,
	`skip_reason` text,
	`meta_message_id` text,
	`meta_recipient_id` text,
	`public_reply_status` text DEFAULT 'not_requested' NOT NULL,
	`public_reply_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`claimed_at` integer,
	`last_error_category` text,
	`last_error_code` text,
	`last_error_message` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`instagram_account_id`) REFERENCES `instagram_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`automation_id`) REFERENCES `automations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "deliveries_status" CHECK("deliveries"."status" in ('RECEIVED', 'SKIPPED', 'QUEUED', 'SENDING', 'SENT', 'RETRYABLE_FAILED', 'PERMANENT_FAILED', 'DELIVERY_UNKNOWN', 'EXPIRED')),
	CONSTRAINT "deliveries_source" CHECK("deliveries"."source" in ('webhook', 'reconciliation', 'manual')),
	CONSTRAINT "deliveries_public_reply_status" CHECK("deliveries"."public_reply_status" in ('not_requested', 'pending', 'sent', 'failed')),
	CONSTRAINT "deliveries_pending_has_next_attempt" CHECK(not ("deliveries"."status" in ('QUEUED', 'RETRYABLE_FAILED')) or "deliveries"."next_attempt_at" is not null),
	CONSTRAINT "deliveries_sending_has_claimed_at" CHECK("deliveries"."status" <> 'SENDING' or "deliveries"."claimed_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_account_comment_unique` ON `deliveries` (`instagram_account_id`,`comment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `deliveries_once_per_user_unique` ON `deliveries` (`automation_id`,`commenter_igsid`) WHERE "deliveries"."counts_toward_once_per_user" = 1;--> statement-breakpoint
CREATE INDEX `deliveries_created_at_idx` ON `deliveries` (`created_at`);--> statement-breakpoint
CREATE INDEX `deliveries_pending_idx` ON `deliveries` (`next_attempt_at`) WHERE "deliveries"."status" in ('QUEUED', 'RETRYABLE_FAILED');--> statement-breakpoint
CREATE INDEX `deliveries_sending_idx` ON `deliveries` (`claimed_at`) WHERE "deliveries"."status" in ('SENDING');--> statement-breakpoint
CREATE INDEX `deliveries_account_claimed_at_idx` ON `deliveries` (`instagram_account_id`,`claimed_at`) WHERE "deliveries"."claimed_at" is not null;--> statement-breakpoint
CREATE TABLE `instagram_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`instagram_user_id` text NOT NULL,
	`username` text NOT NULL,
	`account_type` text,
	`encrypted_access_token` text,
	`token_expires_at` integer,
	`connection_status` text DEFAULT 'connected' NOT NULL,
	`webhook_subscription_status` text DEFAULT 'unknown' NOT NULL,
	`last_connected_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "instagram_accounts_connection_status" CHECK("instagram_accounts"."connection_status" in ('connected', 'needs_reconnect', 'disconnected')),
	CONSTRAINT "instagram_accounts_webhook_subscription_status" CHECK("instagram_accounts"."webhook_subscription_status" in ('unknown', 'subscribed', 'failed', 'unsubscribed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instagram_accounts_instagram_user_id_unique` ON `instagram_accounts` (`instagram_user_id`);--> statement-breakpoint
CREATE TABLE `operational_events` (
	`id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`category` text NOT NULL,
	`safe_message` text NOT NULL,
	`related_delivery_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`related_delivery_id`) REFERENCES `deliveries`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "operational_events_severity" CHECK("operational_events"."severity" in ('info', 'warning', 'error'))
);
--> statement-breakpoint
CREATE INDEX `operational_events_created_at_idx` ON `operational_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`event_type` text NOT NULL,
	`instagram_account_id` text,
	`payload` text,
	`received_at` integer NOT NULL,
	`processing_status` text DEFAULT 'pending' NOT NULL,
	`processed_at` integer,
	`error_category` text,
	FOREIGN KEY (`instagram_account_id`) REFERENCES `instagram_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_events_processing_status" CHECK("webhook_events"."processing_status" in ('pending', 'processed', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_events_event_key_unique` ON `webhook_events` (`event_key`);