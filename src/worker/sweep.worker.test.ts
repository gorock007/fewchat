import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { encryptToken } from "../crypto/tokens";
import type { Db } from "../db/deliveries";
import * as schema from "../db/schema";
import { appSettings, deliveries, instagramAccounts } from "../db/schema";
import { readSettings } from "../db/settings";
import {
  fakeId,
  insertAccount,
  insertAutomation,
  startTestD1,
  type TestD1,
} from "../db/test-d1";
import { deliveryFixture, NOW } from "../delivery/test-fixtures";
import { signFakeBody } from "../meta/fixtures";
import { FAKE_ENV, startWorker } from "./harness";
import { runSweep, SWEEP_BATCH_LIMIT } from "./sweep";

const SECOND = 1000;
const WEBHOOK_PATH = "/api/webhooks/instagram";

type Worker = Awaited<ReturnType<typeof startWorker>>;

async function connect(worker: Worker): Promise<Db> {
  return drizzle((await worker.getD1()) as never, { schema });
}

/** A connected account whose token decrypts under the fake env's key. */
async function seed(db: Db) {
  const account = await insertAccount(db, {
    instagramUserId: fakeId("ig"),
  });
  const encryptedAccessToken = await encryptToken("FAKE_SWEEP_ACCESS_TOKEN", {
    encryptionKey: FAKE_ENV.TOKEN_ENCRYPTION_KEY,
    instagramAccountId: account.id,
  });
  await db
    .update(instagramAccounts)
    .set({ encryptedAccessToken })
    .where(eq(instagramAccounts.id, account.id));
  const automation = await insertAutomation(db, account.id, {
    dmTemplate: "Hello {username}! {resource_url}",
  });
  return { account, automation };
}

/** A pending delivery whose `next_attempt_at` was `dueAgoMs` ago. */
async function pending(
  db: Db,
  seeded: Awaited<ReturnType<typeof seed>>,
  dueAgoMs: number,
  overrides: Partial<schema.NewDelivery> = {},
) {
  const now = Date.now();
  const [delivery] = await db
    .insert(deliveries)
    .values({
      instagramAccountId: seeded.account.id,
      automationId: seeded.automation.id,
      commentId: fakeId("comment"),
      commenterIgsid: fakeId("commenter"),
      commenterUsername: "commenter_fake_name",
      commentTextExcerpt: "comment_fake_text",
      commentCreatedAt: now - 10 * 60 * SECOND,
      status: "QUEUED",
      source: "webhook",
      countsTowardOncePerUser: true,
      nextAttemptAt: now - dueAgoMs,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .returning();
  return delivery!;
}

async function row(db: Db, id: string) {
  const [found] = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.id, id));
  return found!;
}

describe("the real Worker's queue() and scheduled()", () => {
  let worker: Worker;
  let db: Db;

  beforeAll(async () => {
    worker = await startWorker({ spyQueue: true });
    db = await connect(worker);
  });
  afterAll(async () => {
    await worker?.close();
  });
  afterEach(async () => {
    await db.update(appSettings).set({ sendsPaused: false, lastSweepAt: null });
    await db.run(sql`DROP TRIGGER IF EXISTS fake_claim_failure`);
    worker.meta.requests.length = 0;
    worker.queue.calls.length = 0;
  });

  const tick = async () => {
    const result = await (
      await worker.getWorker()
    ).scheduled({
      cron: "* * * * *",
    });
    expect(result.outcome).toBe("ok");
  };

  it("delivers a webhook's queue message: row SENT, one Meta request", async () => {
    const seeded = await seed(db);
    const body = JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: seeded.account.instagramUserId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: "comments",
              value: {
                id: fakeId("comment"),
                from: { id: fakeId("commenter"), username: "fake_commenter" },
                text: "guide please",
                media: { id: seeded.automation.mediaId },
              },
            },
          ],
        },
      ],
    });
    const posted = await worker.fetch(WEBHOOK_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": await signFakeBody(body),
      },
      body,
    });
    expect(posted.status).toBe(200);
    expect(worker.queue.calls).toHaveLength(1);
    const [message] = worker.queue.calls[0] as [{ deliveryId: string }];

    const result = await (
      await worker.getWorker()
    ).queue(worker.queueName, [
      {
        id: "fake-message-1",
        timestamp: new Date(),
        body: message,
        attempts: 1,
      },
    ]);
    expect(result.explicitAcks).toEqual(["fake-message-1"]);
    expect(result.retryMessages).toEqual([]);

    expect((await row(db, message.deliveryId)).status).toBe("SENT");
    expect(worker.meta.requests).toHaveLength(1);
    const [request] = worker.meta.requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(
      `https://graph.instagram.com/v24.0/${seeded.account.instagramUserId}/messages`,
    );
  });

  it("sweeps a QUEUED row due over 60 s ago and leaves one due 10 s ago", async () => {
    const seeded = await seed(db);
    const overdue = await pending(db, seeded, 90 * SECOND);
    const recent = await pending(db, seeded, 10 * SECOND);
    await tick();
    expect((await row(db, overdue.id)).status).toBe("SENT");
    expect((await row(db, recent.id)).status).toBe("QUEUED");
    expect(worker.meta.requests).toHaveLength(1);
  });

  it("quarantines a stale SENDING row without a request", async () => {
    const seeded = await seed(db);
    const stale = await pending(db, seeded, 0, {
      status: "SENDING",
      claimedAt: Date.now() - 2 * 60 * SECOND,
      attemptCount: 1,
    });
    await tick();
    const after = await row(db, stale.id);
    expect(after.status).toBe("DELIVERY_UNKNOWN");
    expect(after.lastErrorCategory).toBe("stale_sending");
    expect(worker.meta.requests).toHaveLength(0);
  });

  it("processes five of seven overdue rows per tick, oldest first", async () => {
    expect(SWEEP_BATCH_LIMIT).toBe(5);
    const seeded = await seed(db);
    const rows = [];
    for (let i = 0; i < 7; i++) {
      rows.push(await pending(db, seeded, (100 - i) * SECOND));
    }
    await tick();
    const first = await Promise.all(rows.map((r) => row(db, r.id)));
    expect(first.map((r) => r.status)).toEqual([
      ...Array(5).fill("SENT"),
      "QUEUED",
      "QUEUED",
    ]);
    expect(worker.meta.requests).toHaveLength(5);

    await tick();
    const second = await Promise.all(rows.map((r) => row(db, r.id)));
    expect(second.every((r) => r.status === "SENT")).toBe(true);
    expect(worker.meta.requests).toHaveLength(7);
  });

  it("sends nothing while paused, then sends on the next tick after unpausing", async () => {
    const seeded = await seed(db);
    const queued = await pending(db, seeded, 90 * SECOND);
    await db.update(appSettings).set({ sendsPaused: true });
    await tick();
    expect((await row(db, queued.id)).status).toBe("QUEUED");
    expect(worker.meta.requests).toHaveLength(0);

    await db.update(appSettings).set({ sendsPaused: false });
    await tick();
    expect((await row(db, queued.id)).status).toBe("SENT");
    expect(worker.meta.requests).toHaveLength(1);
  });

  it("keeps going when one row's claim throws", async () => {
    const seeded = await seed(db);
    const first = await pending(db, seeded, 100 * SECOND);
    const poisoned = await pending(db, seeded, 90 * SECOND);
    const last = await pending(db, seeded, 80 * SECOND);
    await db.run(
      sql.raw(`CREATE TRIGGER fake_claim_failure
        BEFORE UPDATE OF status ON deliveries
        WHEN NEW.id = '${poisoned.id}' AND NEW.status = 'SENDING'
        BEGIN SELECT RAISE(ABORT, 'fake_claim_failure'); END`),
    );
    await tick();
    expect((await row(db, first.id)).status).toBe("SENT");
    expect((await row(db, poisoned.id)).status).toBe("QUEUED");
    expect((await row(db, last.id)).status).toBe("SENT");
    expect(worker.meta.requests).toHaveLength(2);
  });

  it("advances last_sweep_at on every tick", async () => {
    expect((await readSettings(db)).lastSweepAt).toBeNull();
    const before = Date.now();
    await tick();
    const first = (await readSettings(db)).lastSweepAt!;
    expect(first).toBeGreaterThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tick();
    expect((await readSettings(db)).lastSweepAt!).toBeGreaterThan(first);
  });
});

describe("with an invalid config", () => {
  let worker: Worker;
  let db: Db;

  beforeAll(async () => {
    worker = await startWorker({ env: { TOKEN_ENCRYPTION_KEY: "too-short" } });
    db = await connect(worker);
  });
  afterAll(async () => {
    await worker?.close();
  });

  it("retries every queue message and sends nothing", async () => {
    const seeded = await seed(db);
    const queued = await pending(db, seeded, 90 * SECOND);
    const result = await (
      await worker.getWorker()
    ).queue(worker.queueName, [
      {
        id: "fake-message-1",
        timestamp: new Date(),
        body: { deliveryId: queued.id },
        attempts: 1,
      },
      {
        id: "fake-message-2",
        timestamp: new Date(),
        body: { deliveryId: queued.id },
        attempts: 1,
      },
    ]);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(2);
    expect(worker.meta.requests).toHaveLength(0);
    expect((await row(db, queued.id)).status).toBe("QUEUED");
  });

  it("logs and returns from scheduled() without touching D1", async () => {
    const seeded = await seed(db);
    const queued = await pending(db, seeded, 90 * SECOND);
    const result = await (
      await worker.getWorker()
    ).scheduled({
      cron: "* * * * *",
    });
    expect(result.outcome).toBe("ok");
    expect(worker.meta.requests).toHaveLength(0);
    expect((await row(db, queued.id)).status).toBe("QUEUED");
    expect((await readSettings(db)).lastSweepAt).toBeNull();
  });
});

describe("runSweep log line", () => {
  let t: TestD1;
  beforeAll(async () => {
    t = await startTestD1();
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("carries counts only, and classifies a throwing row without its message", async () => {
    const f = await deliveryFixture(t.db);
    const second = await f.insert();
    const secret = "FAKE_SECRET_PROVIDER_TEXT";
    const sendPrivateReply = vi
      .fn()
      .mockRejectedValueOnce(new Error(secret))
      .mockImplementation(f.deps.meta.sendPrivateReply);
    const log = vi.fn();
    const summary = await runSweep(
      { ...f.deps, meta: { sendPrivateReply }, log },
      { now: NOW + 120 * SECOND },
    );
    expect(summary).toEqual({
      quarantined: 0,
      processed: { sent: 1 },
      errors: { ClaimOrProcessingError: 1 },
    });
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        event: "sweep",
        quarantined: 0,
        processed: { sent: 1 },
        errors: { ClaimOrProcessingError: 1 },
      }),
    );
    expect(log.mock.calls[0]![0]).not.toContain(secret);
    expect(log.mock.calls[0]![0]).not.toContain(f.delivery.id);
    expect(log.mock.calls[0]![0]).not.toContain(second.id);
    expect((await readSettings(t.db)).lastSweepAt).toBe(NOW + 120 * SECOND);
  });
});
