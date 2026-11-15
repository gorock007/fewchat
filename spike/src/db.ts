import type { D1Database } from "@cloudflare/workers-types";
import { and, asc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { deliveries, events } from "./schema";

export const database = (binding: D1Database) => drizzle(binding);
export type Database = ReturnType<typeof database>;
export type EventInput = { id: string; accountId: string; commentId: string; receivedAt: number };

export function insertStatements(db: Database, event: EventInput) {
  return [
    db.insert(events).values(event).onConflictDoNothing(),
    db.insert(deliveries).values({ id: event.id, createdAt: event.receivedAt }).onConflictDoNothing(),
  ] as const;
}

export async function persist(db: Database, input: EventInput[]) {
  const queries = input.flatMap((event) => [...insertStatements(db, event)]);
  if (queries.length) await db.batch([queries[0]!, ...queries.slice(1)]);
}

export const claimStatement = (db: Database, id: string, now: number) => db.update(deliveries)
  .set({ status: "SENDING", claimedAt: now, attempts: sql`${deliveries.attempts} + 1` })
  .where(and(eq(deliveries.id, id), eq(deliveries.status, "QUEUED")))
  .returning();

export async function claim(db: Database, id: string) {
  return (await claimStatement(db, id, Date.now()))[0];
}

export async function pending(db: Database) {
  return db.select({ id: deliveries.id }).from(deliveries)
    .where(eq(deliveries.status, "QUEUED"))
    .orderBy(asc(deliveries.createdAt), asc(deliveries.id)).limit(5);
}

export async function markUnknownStale(db: Database, now: number) {
  // A SENDING claim may already have reached Meta. Never reset it to QUEUED.
  // Bound recovery writes as well as send work; a production lease design is still needed.
  await db.run(sql`UPDATE deliveries SET status = 'DELIVERY_UNKNOWN' WHERE id IN
    (SELECT id FROM deliveries WHERE status = 'SENDING' AND claimed_at < ${now - 60_000} LIMIT 5)`);
}

export async function finish(db: Database, id: string, messageId?: string) {
  await db.update(deliveries).set({ status: messageId ? "SENT" : "DELIVERY_UNKNOWN", messageId: messageId ?? null })
    .where(and(eq(deliveries.id, id), eq(deliveries.status, "SENDING")));
}

export async function readDelivery(db: Database, id: string) {
  return (await db.select().from(deliveries).where(eq(deliveries.id, id)))[0];
}

// Exported for the query-build microbenchmark, without issuing a database request.
export const recoveryStatement = (db: Database, cutoff: number) => db.select().from(deliveries)
  .where(and(eq(deliveries.status, "SENDING"), lt(deliveries.claimedAt, cutoff))).limit(5);
