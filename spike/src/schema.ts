import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  commentId: text("comment_id").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const deliveries = sqliteTable("deliveries", {
  id: text("id").primaryKey().references(() => events.id),
  status: text("status", { enum: ["QUEUED", "SENDING", "SENT", "DELIVERY_UNKNOWN"] }).notNull().default("QUEUED"),
  createdAt: integer("created_at").notNull(),
  claimedAt: integer("claimed_at"),
  attempts: integer("attempts").notNull().default(0),
  messageId: text("message_id"),
}, (t) => [
  index("deliveries_pending").on(t.status, t.createdAt, t.id),
  check("deliveries_status", sql`${t.status} in ('QUEUED', 'SENDING', 'SENT', 'DELIVERY_UNKNOWN')`),
]);
