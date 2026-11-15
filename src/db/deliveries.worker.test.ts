import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimDelivery,
  deferDelivery,
  expireDelivery,
  failDelivery,
  finishDelivery,
  pendingDeliveries,
  quarantineStaleSending,
  recordEvents,
  recordEventStatements,
  SKIP_ONCE_PER_USER,
  STALE_SENDING_CATEGORY,
  type ClaimLimits,
  type RecordEventInput,
} from "./deliveries";
import { deliveries, webhookEvents, type Automation } from "./schema";
import {
  fakeId,
  insertAccount,
  insertAutomation,
  startTestD1,
  type TestD1,
} from "./test-d1";

let t: TestD1;

beforeAll(async () => {
  t = await startTestD1();
});

afterAll(async () => {
  await t?.dispose();
});

const T0 = 1_800_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const LOOSE: ClaimLimits = { perHour: 600, burstPerMinute: 30 };

/** A webhook comment on `automation`'s media, as 2a would record it. */
function comment(
  automation: Automation,
  {
    receivedAt = T0,
    status = "QUEUED",
    commenterIgsid = fakeId("igsid"),
    commentId = fakeId("comment"),
  }: {
    receivedAt?: number;
    status?: "QUEUED" | "SKIPPED" | "RECEIVED";
    commenterIgsid?: string;
    commentId?: string;
  } = {},
): RecordEventInput {
  return {
    event: {
      eventKey: `comments:${commentId}`,
      eventType: "comments",
      instagramAccountId: automation.instagramAccountId,
      payload: { commentId, mediaId: automation.mediaId, text: "guide" },
      receivedAt,
    },
    delivery: {
      instagramAccountId: automation.instagramAccountId,
      automationId: automation.id,
      commentId,
      commenterIgsid,
      commenterUsername: "fake_commenter",
      source: "webhook",
      status,
      oncePerUser: automation.oncePerUser,
    },
  };
}

async function setup(overrides: Partial<Automation> = {}) {
  const account = await insertAccount(t.db);
  return insertAutomation(t.db, account.id, overrides);
}

/** Records one QUEUED comment and returns its delivery ID. */
async function queued(automation: Automation, receivedAt = T0) {
  const [recorded] = await recordEvents(t.db, [
    comment(automation, { receivedAt }),
  ]);
  return recorded!.delivery!.id;
}

async function read(id: string) {
  const [row] = await t.db
    .select()
    .from(deliveries)
    .where(eq(deliveries.id, id));
  return row!;
}

async function claimed(id: string, now: number, limits = LOOSE) {
  const result = await claimDelivery(t.db, { id, now, limits });
  expect(result.outcome).toBe("claimed");
}

describe("recordEvents", () => {
  it("records the event and a QUEUED delivery due at once", async () => {
    const automation = await setup();
    const input = comment(automation);
    const [recorded] = await recordEvents(t.db, [input]);

    expect(recorded).toEqual({
      eventInserted: true,
      delivery: { id: expect.any(String), status: "QUEUED" },
    });
    const row = await read(recorded!.delivery!.id);
    expect(row).toMatchObject({
      commentId: input.delivery!.commentId,
      status: "QUEUED",
      countsTowardOncePerUser: true,
      nextAttemptAt: T0,
      createdAt: T0,
      attemptCount: 0,
    });
  });

  it("treats a Meta redelivery of the same comment as a no-op", async () => {
    const automation = await setup();
    const input = comment(automation);
    await recordEvents(t.db, [input]);

    expect(await recordEvents(t.db, [input])).toEqual([
      { eventInserted: false, delivery: undefined },
    ]);
    // A different event key carrying the same comment is still one delivery.
    const resent = {
      ...input,
      event: { ...input.event, eventKey: fakeId("event") },
    };
    expect(await recordEvents(t.db, [resent])).toEqual([
      { eventInserted: true, delivery: undefined },
    ]);
    const [rows] = await t.db
      .select({ n: count() })
      .from(deliveries)
      .where(eq(deliveries.commentId, input.delivery!.commentId));
    expect(rows!.n).toBe(1);
  });

  it("records an unmatched comment as an event only", async () => {
    const automation = await setup();
    const { event } = comment(automation);
    expect(await recordEvents(t.db, [{ event }])).toEqual([
      { eventInserted: true, delivery: undefined },
    ]);
  });

  it("skips a second comment by a commenter who holds the once-per-user slot", async () => {
    const automation = await setup();
    const commenterIgsid = fakeId("igsid");
    const [first, second] = await recordEvents(t.db, [
      comment(automation, { commenterIgsid }),
      comment(automation, { commenterIgsid }),
    ]);

    expect(first!.delivery!.status).toBe("QUEUED");
    expect(second!.delivery!.status).toBe("SKIPPED");
    expect(await read(second!.delivery!.id)).toMatchObject({
      countsTowardOncePerUser: false,
      skipReason: SKIP_ONCE_PER_USER,
      nextAttemptAt: null,
    });
  });

  it("gives exactly one of two concurrent comments the slot", async () => {
    const automation = await setup();
    const commenterIgsid = fakeId("igsid");
    const results = await Promise.all([
      recordEvents(t.db, [comment(automation, { commenterIgsid })]),
      recordEvents(t.db, [comment(automation, { commenterIgsid })]),
    ]);
    expect(results.map(([r]) => r!.delivery!.status).sort()).toEqual([
      "QUEUED",
      "SKIPPED",
    ]);
  });

  it("queues every comment when the automation allows repeats", async () => {
    const automation = await setup({ oncePerUser: false });
    const commenterIgsid = fakeId("igsid");
    const recorded = await recordEvents(t.db, [
      comment(automation, { commenterIgsid }),
      comment(automation, { commenterIgsid }),
    ]);
    expect(recorded.map((r) => r.delivery!.status)).toEqual([
      "QUEUED",
      "QUEUED",
    ]);
  });

  it("does not take the slot for a comment that will not be sent", async () => {
    const automation = await setup();
    const commenterIgsid = fakeId("igsid");
    const [skipped, later] = await recordEvents(t.db, [
      comment(automation, { commenterIgsid, status: "SKIPPED" }),
      comment(automation, { commenterIgsid }),
    ]);
    expect(skipped!.delivery!.status).toBe("SKIPPED");
    expect(later!.delivery!.status).toBe("QUEUED");
  });

  // Miniflare only. ADR 0002 gate 8: confirm on a deployed D1 before relying on it.
  it("rolls back the event when the delivery insert fails", async () => {
    const automation = await setup();
    const input = comment(automation);
    const broken: RecordEventInput = {
      ...input,
      delivery: { ...input.delivery!, automationId: "automation_fake_missing" },
    };
    await expect(recordEvents(t.db, [broken])).rejects.toThrow();

    const events = await t.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.eventKey, input.event.eventKey));
    expect(events).toEqual([]);
    const rows = await t.db
      .select()
      .from(deliveries)
      .where(eq(deliveries.commentId, input.delivery!.commentId));
    expect(rows).toEqual([]);
  });

  it("returns the statements for the caller's own batch", async () => {
    const automation = await setup();
    const input = comment(automation);
    const statements = recordEventStatements(t.db, input);
    // Event, slot-taking delivery, and the SKIPPED fallback.
    expect(statements).toHaveLength(3);
    await t.db.batch(statements);
    expect((await recordEvents(t.db, [input]))[0]!.eventInserted).toBe(false);
  });
});

describe("claimDelivery", () => {
  it("lets exactly one of two concurrent claims win", async () => {
    const id = await queued(await setup());
    const results = await Promise.all([
      claimDelivery(t.db, { id, now: T0, limits: LOOSE }),
      claimDelivery(t.db, { id, now: T0, limits: LOOSE }),
    ]);

    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["claimed", "unavailable"]);
    expect(results).toContainEqual({
      outcome: "unavailable",
      status: "SENDING",
    });
    expect(await read(id)).toMatchObject({
      status: "SENDING",
      claimedAt: T0,
      attemptCount: 1,
    });
  });

  it("refuses a claim at the hourly limit until the oldest claim ages out", async () => {
    const automation = await setup();
    const limits = { perHour: 2, burstPerMinute: 30 };
    const [a, b, c] = [
      await queued(automation),
      await queued(automation),
      await queued(automation),
    ];
    await claimed(a, T0, limits);
    await claimed(b, T0 + MINUTE, limits);
    // SENT and DELIVERY_UNKNOWN still count: they may have reached Meta.
    await finishDelivery(t.db, {
      id: a,
      now: T0 + 1,
      metaMessageId: "mid_fake_1",
    });
    await failDelivery(t.db, {
      id: b,
      now: T0 + MINUTE + 1,
      status: "DELIVERY_UNKNOWN",
      errorCategory: "timeout",
    });

    expect(
      await claimDelivery(t.db, { id: c, now: T0 + 2 * MINUTE, limits }),
    ).toEqual({ outcome: "rate_limited", retryAt: T0 + HOUR });
    expect((await read(c)).status).toBe("QUEUED");

    expect(
      await claimDelivery(t.db, { id: c, now: T0 + HOUR - 1, limits }),
    ).toMatchObject({ outcome: "rate_limited" });
    await claimed(c, T0 + HOUR, limits);
  });

  it("refuses a burst over the per-minute limit", async () => {
    const automation = await setup();
    const limits = { perHour: 600, burstPerMinute: 1 };
    const [a, b] = [await queued(automation), await queued(automation)];
    await claimed(a, T0, limits);
    expect(
      await claimDelivery(t.db, { id: b, now: T0 + 1000, limits }),
    ).toEqual({ outcome: "rate_limited", retryAt: T0 + MINUTE });
    await claimed(b, T0 + MINUTE, limits);
  });

  it("does not count a retryable failure or another account's claims", async () => {
    const automation = await setup();
    const limits = { perHour: 1, burstPerMinute: 30 };
    const [a, b] = [await queued(automation), await queued(automation)];
    await claimed(a, T0, limits);
    await failDelivery(t.db, {
      id: a,
      now: T0 + 1,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: T0 + MINUTE,
      errorCategory: "rate_limited_by_meta",
    });

    const elsewhere = await queued(await setup());
    await claimed(elsewhere, T0 + 2, limits);
    await claimed(b, T0 + 3, limits);
  });

  it("re-claims a retryable failure and counts the attempt", async () => {
    const id = await queued(await setup());
    await claimed(id, T0);
    await failDelivery(t.db, {
      id,
      now: T0 + 1,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: T0 + MINUTE,
      errorCategory: "meta_5xx",
      errorCode: "2",
      errorMessage: "Temporary failure (fake)",
    });
    expect(await read(id)).toMatchObject({
      status: "RETRYABLE_FAILED",
      nextAttemptAt: T0 + MINUTE,
      lastErrorCategory: "meta_5xx",
    });
    await claimed(id, T0 + MINUTE);
    expect((await read(id)).attemptCount).toBe(2);
  });

  it("never claims a sent, failed or unknown delivery", async () => {
    const automation = await setup();
    for (const end of [
      "SENT",
      "PERMANENT_FAILED",
      "DELIVERY_UNKNOWN",
    ] as const) {
      const id = await queued(automation);
      await claimed(id, T0);
      if (end === "SENT") {
        await finishDelivery(t.db, { id, now: T0, metaMessageId: "mid_fake" });
      } else {
        await failDelivery(t.db, {
          id,
          now: T0,
          status: end,
          errorCategory: "x",
        });
      }
      expect(
        await claimDelivery(t.db, { id, now: T0 + HOUR * 2, limits: LOOSE }),
      ).toEqual({ outcome: "unavailable", status: end });
    }
    expect(
      await claimDelivery(t.db, {
        id: "delivery_fake_missing",
        now: T0,
        limits: LOOSE,
      }),
    ).toEqual({ outcome: "unavailable", status: null });
  });
});

describe("finishDelivery and failDelivery", () => {
  it.each(["PERMANENT_FAILED", "EXPIRED"] as const)(
    "%s releases the slot for a later comment, without reviving skipped comments",
    async (status) => {
      const automation = await setup();
      const commenterIgsid = fakeId("slot_user");
      const [first, skipped] = await recordEvents(t.db, [
        comment(automation, { commenterIgsid }),
        comment(automation, { commenterIgsid }),
      ]);
      const id = first!.delivery!.id;
      expect(skipped!.delivery!.status).toBe("SKIPPED");
      if (status === "PERMANENT_FAILED") {
        await claimed(id, T0);
        expect(
          await failDelivery(t.db, {
            id,
            now: T0,
            status,
            errorCategory: "fake_terminal",
          }),
        ).toBe(true);
      } else {
        expect(
          await expireDelivery(t.db, {
            id,
            now: T0,
            errorCategory: "fake_expired",
          }),
        ).toBe(true);
      }
      expect(await read(id)).toMatchObject({
        status,
        countsTowardOncePerUser: false,
        nextAttemptAt: null,
      });
      const [next] = await recordEvents(t.db, [
        comment(automation, { commenterIgsid }),
      ]);
      expect(next!.delivery!.status).toBe("QUEUED");
      expect((await read(skipped!.delivery!.id)).status).toBe("SKIPPED");
    },
  );

  it("UNKNOWN retains the slot and refuses expiration or permanent failure", async () => {
    const automation = await setup();
    const commenterIgsid = fakeId("unknown_slot_user");
    const [first] = await recordEvents(t.db, [
      comment(automation, { commenterIgsid }),
    ]);
    const id = first!.delivery!.id;
    await claimed(id, T0);
    await failDelivery(t.db, {
      id,
      now: T0,
      status: "DELIVERY_UNKNOWN",
      errorCategory: "unknown",
    });
    const before = await read(id);
    expect(
      await expireDelivery(t.db, { id, now: T0 + 1, errorCategory: "expired" }),
    ).toBe(false);
    expect(
      await failDelivery(t.db, {
        id,
        now: T0 + 1,
        status: "PERMANENT_FAILED",
        errorCategory: "fake_terminal",
      }),
    ).toBe(false);
    expect(await read(id)).toEqual(before);
    const [next] = await recordEvents(t.db, [
      comment(automation, { commenterIgsid }),
    ]);
    expect(next!.delivery!.status).toBe("SKIPPED");
    expect(before.countsTowardOncePerUser).toBe(true);
  });

  it("defers/expires only pending rows, preserving attempts and slots when deferring", async () => {
    const id = await queued(await setup());
    expect(
      await deferDelivery(t.db, { id, now: T0, nextAttemptAt: T0 + MINUTE }),
    ).toBe(true);
    expect(await read(id)).toMatchObject({
      status: "QUEUED",
      nextAttemptAt: T0 + MINUTE,
      attemptCount: 0,
      countsTowardOncePerUser: true,
    });
    await claimed(id, T0 + MINUTE);
    const before = await read(id);
    expect(
      await deferDelivery(t.db, { id, now: T0, nextAttemptAt: T0 + HOUR }),
    ).toBe(false);
    expect(
      await expireDelivery(t.db, { id, now: T0, errorCategory: "expired" }),
    ).toBe(false);
    expect(await read(id)).toEqual(before);
    await failDelivery(t.db, {
      id,
      now: T0,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: T0 + MINUTE,
      errorCategory: "not_sent",
    });
    expect(
      await deferDelivery(t.db, { id, now: T0, nextAttemptAt: T0 + HOUR }),
    ).toBe(true);
    expect((await read(id)).attemptCount).toBe(1);
    expect(
      await expireDelivery(t.db, { id, now: T0, errorCategory: "expired" }),
    ).toBe(true);
    expect((await read(id)).countsTowardOncePerUser).toBe(false);
    expect(
      await deferDelivery(t.db, { id, now: T0, nextAttemptAt: T0 + HOUR }),
    ).toBe(false);
    expect(
      await expireDelivery(t.db, {
        id: "missing_fake_id",
        now: T0,
        errorCategory: "expired",
      }),
    ).toBe(false);
  });

  it("finishes a SENDING delivery with Meta's message ID", async () => {
    const id = await queued(await setup());
    await claimed(id, T0);
    expect(
      await finishDelivery(t.db, {
        id,
        now: T0 + 500,
        metaMessageId: "mid_fake_ok",
        metaRecipientId: "igsid_fake_recipient",
      }),
    ).toBe(true);
    expect(await read(id)).toMatchObject({
      status: "SENT",
      metaMessageId: "mid_fake_ok",
      metaRecipientId: "igsid_fake_recipient",
      sentAt: T0 + 500,
    });
  });

  it("refuses a delivery that is not SENDING", async () => {
    const automation = await setup();
    const fresh = await queued(automation);
    expect(
      await finishDelivery(t.db, {
        id: fresh,
        now: T0,
        metaMessageId: "mid_fake",
      }),
    ).toBe(false);
    expect(
      await failDelivery(t.db, {
        id: fresh,
        now: T0,
        status: "PERMANENT_FAILED",
        errorCategory: "x",
      }),
    ).toBe(false);
    expect((await read(fresh)).status).toBe("QUEUED");

    const sent = await queued(automation);
    await claimed(sent, T0);
    await finishDelivery(t.db, {
      id: sent,
      now: T0,
      metaMessageId: "mid_fake_1",
    });
    expect(
      await finishDelivery(t.db, {
        id: sent,
        now: T0,
        metaMessageId: "mid_fake_2",
      }),
    ).toBe(false);
    expect(
      await failDelivery(t.db, {
        id: sent,
        now: T0,
        status: "DELIVERY_UNKNOWN",
        errorCategory: "x",
      }),
    ).toBe(false);
    expect(await read(sent)).toMatchObject({
      status: "SENT",
      metaMessageId: "mid_fake_1",
    });
  });
});

describe("sweep", () => {
  // The sweep reads across accounts, so each test starts from an empty database.
  beforeEach(async () => {
    await t.dispose();
    t = await startTestD1();
  });

  it("quarantines stale SENDING as DELIVERY_UNKNOWN and never offers it again", async () => {
    const automation = await setup();
    const now = T0 + 10 * HOUR;
    const stale = await queued(automation, now - HOUR);
    const fresh = await queued(automation, now - HOUR);
    await claimed(stale, now - 61 * 1000);
    await claimed(fresh, now - 30 * 1000);

    expect(await quarantineStaleSending(t.db, { now })).toEqual([stale]);
    expect(await read(stale)).toMatchObject({
      status: "DELIVERY_UNKNOWN",
      lastErrorCategory: STALE_SENDING_CATEGORY,
    });
    expect((await read(fresh)).status).toBe("SENDING");

    const later = now + 2 * HOUR;
    const due = await pendingDeliveries(t.db, { now: later, limit: 100 });
    expect(due.map((d) => d.id)).not.toContain(stale);
    expect(
      await claimDelivery(t.db, { id: stale, now: later, limits: LOOSE }),
    ).toEqual({ outcome: "unavailable", status: "DELIVERY_UNKNOWN" });
    // A late failure from the original sender is refused: only SENDING fails.
    expect(
      await failDelivery(t.db, {
        id: stale,
        now: later,
        status: "RETRYABLE_FAILED",
        nextAttemptAt: later,
        errorCategory: "meta_5xx",
      }),
    ).toBe(false);
    expect((await read(stale)).status).toBe("DELIVERY_UNKNOWN");

    // But a late success from the original sender is recorded.
    expect(
      await finishDelivery(t.db, {
        id: stale,
        now: later,
        metaMessageId: "mid_fake_late",
      }),
    ).toBe(true);
    expect(await read(stale)).toMatchObject({
      status: "SENT",
      metaMessageId: "mid_fake_late",
      sentAt: later,
    });
  });

  it("quarantines at most `limit` rows per call, oldest claim first", async () => {
    const automation = await setup();
    const now = T0 + 20 * HOUR;
    const ids = [
      await queued(automation),
      await queued(automation),
      await queued(automation),
    ];
    for (const [i, id] of ids.entries())
      await claimed(id, now - 10 * MINUTE + i);

    expect(
      await quarantineStaleSending(t.db, {
        now,
        olderThanMs: MINUTE,
        limit: 2,
      }),
    ).toEqual(ids.slice(0, 2));
    expect(
      await quarantineStaleSending(t.db, {
        now,
        olderThanMs: MINUTE,
        limit: 2,
      }),
    ).toEqual(ids.slice(2));
  });

  it("lists due pending deliveries, earliest first, up to the limit", async () => {
    const automation = await setup();
    const base = T0 + 30 * HOUR;
    const late = await queued(automation, base + 2);
    const early = await queued(automation, base + 1);
    const notYet = await queued(automation, base + HOUR);
    const retry = await queued(automation, base);
    await claimed(retry, base);
    await failDelivery(t.db, {
      id: retry,
      now: base,
      status: "RETRYABLE_FAILED",
      nextAttemptAt: base + 3,
      errorCategory: "meta_5xx",
    });

    const due = await pendingDeliveries(t.db, { now: base + 10, limit: 10 });
    expect(due.map((d) => d.id)).toEqual([early, late, retry]);
    expect(due[2]).toMatchObject({
      status: "RETRYABLE_FAILED",
      attemptCount: 1,
    });
    expect(due.map((d) => d.id)).not.toContain(notYet);

    const first = await pendingDeliveries(t.db, { now: base + 10, limit: 1 });
    expect(first.map((d) => d.id)).toEqual([early]);
  });
});
