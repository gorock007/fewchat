import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ABANDONED_JOB_ERROR,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  recoverAbandonedJobs,
  rescheduleJob,
} from "./queue";
import { deliveries, jobs } from "./schema";
import {
  createTestDatabase,
  insertAccount,
  insertAutomation,
  insertDelivery,
  type TestDatabase,
} from "./test-utils";

let testDb: TestDatabase;
let automation: Awaited<ReturnType<typeof insertAutomation>>;

const T0 = new Date("2026-01-01T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const account = await insertAccount(testDb.db);
  automation = await insertAutomation(testDb.db, account.id);
});

afterAll(async () => {
  await testDb?.teardown();
});

beforeEach(async () => {
  await testDb.db.delete(jobs);
});

async function newDeliveryJob(runAfter = T0, jobType = "send_dm") {
  const delivery = await insertDelivery(testDb.db, automation);
  const job = await enqueueJob(testDb.db, {
    jobType,
    deliveryId: delivery.id,
    runAfter,
  });
  return { delivery, job: job! };
}

describe("enqueueJob", () => {
  it("ignores a duplicate (job_type, delivery_id)", async () => {
    const { delivery, job } = await newDeliveryJob();
    expect(job.status).toBe("pending");

    const again = await enqueueJob(testDb.db, {
      jobType: "send_dm",
      deliveryId: delivery.id,
    });
    expect(again).toBeUndefined();

    const other = await enqueueJob(testDb.db, {
      jobType: "send_public_reply",
      deliveryId: delivery.id,
    });
    expect(other).toBeDefined();
    expect(await testDb.db.$count(jobs)).toBe(2);
  });

  it("works inside a transaction and rolls back with it", async () => {
    const delivery = await insertDelivery(testDb.db, automation);
    await expect(
      testDb.db.transaction(async (tx) => {
        await enqueueJob(tx, { jobType: "send_dm", deliveryId: delivery.id });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await testDb.db.$count(jobs)).toBe(0);
  });
});

describe("claimJobs", () => {
  it("claims due jobs oldest first and marks them running", async () => {
    const later = await newDeliveryJob(minutes(-1));
    const earlier = await newDeliveryJob(minutes(-5));

    const claimed = await claimJobs(testDb.db, {
      workerId: "worker-a",
      limit: 10,
      now: T0,
    });
    expect(claimed.map((j) => j.id)).toEqual([earlier.job.id, later.job.id]);
    for (const job of claimed) {
      expect(job.status).toBe("running");
      expect(job.lockedBy).toBe("worker-a");
      expect(job.lockedAt).toEqual(T0);
      expect(job.attempts).toBe(1);
    }
    expect(
      await claimJobs(testDb.db, { workerId: "worker-b", limit: 10, now: T0 }),
    ).toEqual([]);
  });

  it("respects run_after and limit", async () => {
    const due = await newDeliveryJob(minutes(-1));
    await newDeliveryJob(minutes(-2));
    const future = await newDeliveryJob(minutes(5));

    const first = await claimJobs(testDb.db, {
      workerId: "w",
      limit: 1,
      now: T0,
    });
    expect(first).toHaveLength(1);
    expect(first[0]!.id).not.toBe(due.job.id); // the older one goes first

    const second = await claimJobs(testDb.db, {
      workerId: "w",
      limit: 10,
      now: T0,
    });
    expect(second.map((j) => j.id)).toEqual([due.job.id]);

    const atFive = await claimJobs(testDb.db, {
      workerId: "w",
      limit: 10,
      now: minutes(5),
    });
    expect(atFive.map((j) => j.id)).toEqual([future.job.id]);
  });

  it("never gives the same job to two concurrent workers", async () => {
    const total = 60;
    const enqueued = await Promise.all(
      Array.from({ length: total }, () => newDeliveryJob(minutes(-1))),
    );

    // Separate connection pools, so the claims really run concurrently.
    const workers = Array.from({ length: 6 }, (_, i) => ({
      id: `worker-${i}`,
      db: testDb.connect(),
    }));
    const claimedBy = new Map<string, string[]>();
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const batch = await claimJobs(worker.db, {
            workerId: worker.id,
            limit: 3,
            now: T0,
          });
          if (batch.length === 0) return;
          for (const job of batch) {
            claimedBy.set(job.id, [
              ...(claimedBy.get(job.id) ?? []),
              worker.id,
            ]);
          }
        }
      }),
    );

    expect(claimedBy.size).toBe(total);
    for (const owners of claimedBy.values()) expect(owners).toHaveLength(1);
    expect(new Set(claimedBy.keys())).toEqual(
      new Set(enqueued.map((e) => e.job.id)),
    );
    const rows = await testDb.db.select().from(jobs);
    for (const row of rows) {
      expect(row.status).toBe("running");
      expect(row.attempts).toBe(1);
      expect(row.lockedBy).toBe(claimedBy.get(row.id)![0]);
    }
  });
});

describe("completing, rescheduling and failing", () => {
  async function claimOne(workerId = "worker-a", now = T0) {
    const [job] = await claimJobs(testDb.db, { workerId, limit: 1, now });
    return job!;
  }

  it("completeJob marks done and clears the lock", async () => {
    await newDeliveryJob();
    const job = await claimOne();
    expect(
      await completeJob(testDb.db, { id: job.id, workerId: "worker-a" }),
    ).toBe(true);
    const [row] = await testDb.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(row).toMatchObject({
      status: "done",
      lockedBy: null,
      lockedAt: null,
    });
  });

  it("rescheduleJob returns the job to pending until runAfter, keeping attempts", async () => {
    await newDeliveryJob();
    const job = await claimOne();
    expect(
      await rescheduleJob(testDb.db, {
        id: job.id,
        workerId: "worker-a",
        runAfter: minutes(10),
        error: "rate_limited",
      }),
    ).toBe(true);

    const [row] = await testDb.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(row).toMatchObject({
      status: "pending",
      runAfter: minutes(10),
      lockedBy: null,
      lockedAt: null,
      lastError: "rate_limited",
      attempts: 1,
    });

    expect(
      await claimJobs(testDb.db, { workerId: "w", limit: 5, now: minutes(9) }),
    ).toEqual([]);
    const retried = await claimOne("worker-b", minutes(10));
    expect(retried.id).toBe(job.id);
    expect(retried.attempts).toBe(2);
  });

  it("failJob marks failed with the error", async () => {
    await newDeliveryJob();
    const job = await claimOne();
    expect(
      await failJob(testDb.db, {
        id: job.id,
        workerId: "worker-a",
        error: "permission_missing",
      }),
    ).toBe(true);
    const [row] = await testDb.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, job.id));
    expect(row).toMatchObject({
      status: "failed",
      lastError: "permission_missing",
    });
  });

  it("refuses to act for a worker that no longer owns the job", async () => {
    await newDeliveryJob();
    const job = await claimOne();
    const intruder = { id: job.id, workerId: "worker-b" };
    expect(await completeJob(testDb.db, intruder)).toBe(false);
    expect(await failJob(testDb.db, { ...intruder, error: "x" })).toBe(false);
    expect(
      await rescheduleJob(testDb.db, { ...intruder, runAfter: T0, error: "x" }),
    ).toBe(false);

    await completeJob(testDb.db, { id: job.id, workerId: "worker-a" });
    // Finished jobs can't be finished again, even by their last owner.
    expect(
      await failJob(testDb.db, {
        id: job.id,
        workerId: "worker-a",
        error: "x",
      }),
    ).toBe(false);
  });
});

describe("recoverAbandonedJobs", () => {
  it("returns stale running jobs to pending, but leaves mid-send ones alone", async () => {
    const stale = await newDeliveryJob(minutes(-30));
    const midSend = await newDeliveryJob(minutes(-30));
    await claimJobs(testDb.db, {
      workerId: "dead-worker",
      limit: 10,
      now: minutes(-20),
    });
    await testDb.db
      .update(deliveries)
      .set({ status: "SENDING" })
      .where(eq(deliveries.id, midSend.delivery.id));

    const fresh = await newDeliveryJob(minutes(-1));
    await claimJobs(testDb.db, { workerId: "live-worker", limit: 10, now: T0 });
    const waiting = await newDeliveryJob(minutes(60));

    const result = await recoverAbandonedJobs(testDb.db, {
      olderThanMs: 5 * 60_000,
      now: T0,
    });

    expect(result.recovered.map((j) => j.id)).toEqual([stale.job.id]);
    expect(result.recovered[0]).toMatchObject({
      status: "pending",
      lockedBy: null,
      lockedAt: null,
      runAfter: T0,
      lastError: ABANDONED_JOB_ERROR,
      attempts: 1,
    });
    expect(result.midSend.map((j) => j.id)).toEqual([midSend.job.id]);

    const byId = new Map(
      (await testDb.db.select().from(jobs)).map((row) => [row.id, row]),
    );
    // Mid-send job is untouched: still running and owned by the dead worker.
    expect(byId.get(midSend.job.id)).toMatchObject({
      status: "running",
      lockedBy: "dead-worker",
    });
    expect(byId.get(fresh.job.id)).toMatchObject({
      status: "running",
      lockedBy: "live-worker",
    });
    expect(byId.get(waiting.job.id)).toMatchObject({ status: "pending" });

    // The recovered job is claimable again; the dead worker can't finish it.
    const [reclaimed] = await claimJobs(testDb.db, {
      workerId: "new-worker",
      limit: 10,
      now: T0,
    });
    expect(reclaimed).toMatchObject({ id: stale.job.id, attempts: 2 });
    expect(
      await completeJob(testDb.db, {
        id: stale.job.id,
        workerId: "dead-worker",
      }),
    ).toBe(false);
  });

  it("recovers stale jobs that have no delivery", async () => {
    const job = await enqueueJob(testDb.db, {
      jobType: "reconcile",
      deliveryId: null,
      runAfter: minutes(-30),
    });
    await claimJobs(testDb.db, {
      workerId: "dead-worker",
      limit: 1,
      now: minutes(-20),
    });

    const result = await recoverAbandonedJobs(testDb.db, {
      olderThanMs: 60_000,
      now: T0,
    });
    expect(result.recovered.map((j) => j.id)).toEqual([job!.id]);
    expect(result.midSend).toEqual([]);
  });
});
