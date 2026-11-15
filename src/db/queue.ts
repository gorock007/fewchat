// Durable PostgreSQL job queue (PRD §8.3). Jobs live in the same database as
// the deliveries they act on, so a job can be enqueued in the same
// transaction that creates its delivery, and both survive restarts.
//
// A worker owns a job from `claimJobs` until it calls `completeJob`,
// `rescheduleJob` or `failJob`; those only act while the job is still
// `running` and locked by that worker, so a job that recovery handed to
// someone else can't be finished by its old owner.
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";

import type { DbOrTx } from "./client";
import { deliveries, jobs } from "./schema";

export type Job = typeof jobs.$inferSelect;

export async function enqueueJob(
  db: DbOrTx,
  input: { jobType: string; deliveryId: string | null; runAfter?: Date },
): Promise<Job | undefined> {
  // A repeated enqueue for the same (job_type, delivery_id) is a no-op and
  // returns undefined.
  const [job] = await db
    .insert(jobs)
    .values({
      jobType: input.jobType,
      deliveryId: input.deliveryId,
      ...(input.runAfter ? { runAfter: input.runAfter } : {}),
    })
    .onConflictDoNothing({ target: [jobs.jobType, jobs.deliveryId] })
    .returning();
  return job;
}

/**
 * Atomically claims up to `limit` due jobs, oldest `run_after` first.
 * `FOR UPDATE SKIP LOCKED` lets concurrent workers claim disjoint sets
 * without waiting on each other.
 */
export async function claimJobs(
  db: DbOrTx,
  input: { workerId: string; limit: number; now: Date },
): Promise<Job[]> {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.status, "pending"), lte(jobs.runAfter, input.now)))
    .orderBy(asc(jobs.runAfter))
    .limit(input.limit)
    .for("update", { skipLocked: true });

  const claimed = await db
    .update(jobs)
    .set({
      status: "running",
      lockedAt: input.now,
      lockedBy: input.workerId,
      attempts: sql`${jobs.attempts} + 1`,
    })
    .where(inArray(jobs.id, due))
    .returning();
  // RETURNING has no order of its own.
  return claimed.sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime());
}

function ownedBy(id: string, workerId: string) {
  return and(
    eq(jobs.id, id),
    eq(jobs.status, "running"),
    eq(jobs.lockedBy, workerId),
  );
}

/** Returns false if the job is no longer this worker's. */
export async function completeJob(
  db: DbOrTx,
  input: { id: string; workerId: string },
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "done", lockedAt: null, lockedBy: null, lastError: null })
    .where(ownedBy(input.id, input.workerId))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Puts the job back to `pending` until `runAfter`. Returns false if the job is no longer this worker's. */
export async function rescheduleJob(
  db: DbOrTx,
  input: { id: string; workerId: string; runAfter: Date; error: string },
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "pending",
      runAfter: input.runAfter,
      lockedAt: null,
      lockedBy: null,
      lastError: input.error,
    })
    .where(ownedBy(input.id, input.workerId))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Marks the job permanently failed. Returns false if the job is no longer this worker's. */
export async function failJob(
  db: DbOrTx,
  input: { id: string; workerId: string; error: string },
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "failed",
      lockedAt: null,
      lockedBy: null,
      lastError: input.error,
    })
    .where(ownedBy(input.id, input.workerId))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export const ABANDONED_JOB_ERROR = "abandoned: worker lease expired";

/**
 * Finds `running` jobs locked longer than `olderThanMs` (their worker is
 * presumed dead) and returns them to `pending`, except jobs whose delivery is
 * `SENDING`: that worker may have reached Meta before dying, so retrying
 * could send a duplicate DM (PRD §8.3). Those are left untouched and
 * returned as `midSend`.
 *
 * For this to be safe against a slow-but-alive worker, the delivery worker
 * must move a delivery to SENDING in a transaction that first re-locks its
 * job (`SELECT … FROM jobs WHERE id = $1 AND locked_by = $me AND status =
 * 'running' FOR UPDATE`) and aborts if that returns nothing. Recovery skips
 * locked jobs, so either it sees SENDING or the worker sees it lost the job.
 */
export async function recoverAbandonedJobs(
  db: DbOrTx,
  input: { olderThanMs: number; now: Date },
): Promise<{ recovered: Job[]; midSend: Job[] }> {
  const cutoff = new Date(input.now.getTime() - input.olderThanMs);
  const stale = and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff));

  const recoverable = db
    .select({ id: jobs.id })
    .from(jobs)
    .leftJoin(deliveries, eq(deliveries.id, jobs.deliveryId))
    .where(
      and(stale, or(isNull(jobs.deliveryId), ne(deliveries.status, "SENDING"))),
    )
    .for("update", { of: jobs, skipLocked: true });

  const recovered = await db
    .update(jobs)
    .set({
      status: "pending",
      runAfter: input.now,
      lockedAt: null,
      lockedBy: null,
      lastError: ABANDONED_JOB_ERROR,
    })
    .where(inArray(jobs.id, recoverable))
    .returning();

  // TODO(delivery worker phase): turn these deliveries into DELIVERY_UNKNOWN
  // and finish their jobs, rather than leaving them `running` here.
  const midSend = await db
    .select({ job: jobs })
    .from(jobs)
    .innerJoin(deliveries, eq(deliveries.id, jobs.deliveryId))
    .where(and(stale, eq(deliveries.status, "SENDING")));

  return { recovered, midSend: midSend.map((row) => row.job) };
}
