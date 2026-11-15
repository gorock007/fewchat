CREATE TYPE "public"."connection_status" AS ENUM('connected', 'needs_reconnect', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."delivery_source" AS ENUM('webhook', 'reconciliation', 'manual');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('RECEIVED', 'SKIPPED', 'QUEUED', 'SENDING', 'SENT', 'RETRYABLE_FAILED', 'PERMANENT_FAILED', 'DELIVERY_UNKNOWN', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."event_severity" AS ENUM('info', 'warning', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."match_mode" AS ENUM('exact', 'whole_word', 'contains');--> statement-breakpoint
CREATE TYPE "public"."public_reply_status" AS ENUM('not_requested', 'pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('keyword', 'any');--> statement-breakpoint
CREATE TYPE "public"."webhook_processing_status" AS ENUM('pending', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_subscription_status" AS ENUM('unknown', 'subscribed', 'failed', 'unsubscribed');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"sends_paused" boolean DEFAULT false NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"last_webhook_at" timestamp with time zone,
	"last_reconciliation_at" timestamp with time zone,
	"worker_heartbeat_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK ("app_settings"."id" = 1),
	CONSTRAINT "app_settings_retention_days_positive" CHECK ("app_settings"."retention_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"media_id" text NOT NULL,
	"media_type" text,
	"trigger_type" "trigger_type" NOT NULL,
	"keyword" text,
	"match_mode" "match_mode",
	"dm_template" text NOT NULL,
	"resource_url" text NOT NULL,
	"public_reply_enabled" boolean DEFAULT false NOT NULL,
	"public_reply_template" text,
	"once_per_user" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_keyword_trigger_has_keyword" CHECK ("automations"."trigger_type" <> 'keyword' or ("automations"."keyword" is not null and "automations"."match_mode" is not null)),
	CONSTRAINT "automations_deleted_is_inactive" CHECK ("automations"."deleted_at" is null or not "automations"."is_active")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instagram_account_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"comment_id" text NOT NULL,
	"commenter_igsid" text,
	"commenter_username" text,
	"comment_text_excerpt" text,
	"comment_created_at" timestamp with time zone,
	"source" "delivery_source" NOT NULL,
	"status" "delivery_status" DEFAULT 'RECEIVED' NOT NULL,
	"counts_toward_once_per_user" boolean DEFAULT false NOT NULL,
	"meta_message_id" text,
	"meta_recipient_id" text,
	"public_reply_status" "public_reply_status" DEFAULT 'not_requested' NOT NULL,
	"public_reply_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_category" text,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instagram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instagram_user_id" text NOT NULL,
	"username" text NOT NULL,
	"account_type" text,
	"encrypted_access_token" text,
	"token_expires_at" timestamp with time zone,
	"connection_status" "connection_status" DEFAULT 'connected' NOT NULL,
	"webhook_subscription_status" "webhook_subscription_status" DEFAULT 'unknown' NOT NULL,
	"last_connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instagram_accounts_instagram_user_id_unique" UNIQUE("instagram_user_id")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_type" text NOT NULL,
	"delivery_id" uuid,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" "event_severity" NOT NULL,
	"category" text NOT NULL,
	"safe_message" text NOT NULL,
	"related_delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"instagram_account_id" uuid,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_status" "webhook_processing_status" DEFAULT 'pending' NOT NULL,
	"processed_at" timestamp with time zone,
	"error_category" text,
	CONSTRAINT "webhook_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_related_delivery_id_deliveries_id_fk" FOREIGN KEY ("related_delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_instagram_account_id_instagram_accounts_id_fk" FOREIGN KEY ("instagram_account_id") REFERENCES "public"."instagram_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_one_active_per_media" ON "automations" USING btree ("instagram_account_id","media_id") WHERE "automations"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_account_comment_unique" ON "deliveries" USING btree ("instagram_account_id","comment_id");--> statement-breakpoint
CREATE INDEX "deliveries_automation_status_idx" ON "deliveries" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "deliveries_comment_created_at_idx" ON "deliveries" USING btree ("comment_created_at");--> statement-breakpoint
CREATE INDEX "deliveries_automation_commenter_idx" ON "deliveries" USING btree ("automation_id","commenter_igsid");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_once_per_user_unique" ON "deliveries" USING btree ("automation_id","commenter_igsid") WHERE "deliveries"."counts_toward_once_per_user";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_type_delivery_unique" ON "jobs" USING btree ("job_type","delivery_id");--> statement-breakpoint
CREATE INDEX "jobs_status_run_after_idx" ON "jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "operational_events_created_at_idx" ON "operational_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhook_events_processing_status_idx" ON "webhook_events" USING btree ("processing_status");