import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as deliveryWrites from "../db/deliveries";
import * as accountWrites from "../db/accounts-write";
import { appSettings, deliveries } from "../db/schema";
import { startTestD1, type TestD1 } from "../db/test-d1";
import {
  deliveryFixture,
  FAKE_KEY,
  FAKE_TOKEN,
  NOW,
  rejection,
} from "../delivery/test-fixtures";
import { handleDeliveryBatch, MAX_QUEUE_DELAY_SECONDS } from "./consumer";

let t: TestD1;
beforeAll(async () => {
  t = await startTestD1();
});
afterAll(async () => {
  await t?.dispose();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.db
    .update(appSettings)
    .set({ sendsPaused: false })
    .where(eq(appSettings.id, 1));
});

function fakeBatch(...bodies: unknown[]) {
  const messages = bodies.map((body, index) => ({
    id: `queue_fake_${index}`,
    timestamp: new Date(NOW),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  const batch = {
    queue: "queue_fake",
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } satisfies MessageBatch<unknown>;
  return { batch, messages };
}

describe("handleDeliveryBatch", () => {
  it("retries an empty deployment key without claiming, sending, or changing either row", async () => {
    const f = await deliveryFixture(t.db);
    const before = await f.read();
    const accountBefore = await f.readAccount();
    const claim = vi.spyOn(deliveryWrites, "claimDelivery");
    const log = vi.fn();
    const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
    await handleDeliveryBatch(batch, {
      ...f.deps,
      tokenEncryptionKey: "",
      log,
    });
    expect(messages[0]!.retry).toHaveBeenCalledExactlyOnceWith();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.read()).toEqual(before);
    expect(await f.readAccount()).toEqual(accountBefore);
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        deliveryId: f.delivery.id,
        result: "error",
        errorClass: "BeforeClaimError",
      }),
    );
  });

  it.each(["decrypt", "token_invalid"])(
    "acks durable %s failure and logs only a fixed class for the account-write error",
    async (scenario) => {
      const f = await deliveryFixture(t.db, () => rejection(190));
      if (scenario === "decrypt") f.deps.tokenEncryptionKey = "FAKE_WRONG_KEY";
      const error = new Error(
        `Synthetic sensitive detail ${FAKE_TOKEN} ${FAKE_KEY}`,
      );
      error.name = FAKE_TOKEN;
      vi.spyOn(accountWrites, "markNeedsReconnect").mockRejectedValueOnce(
        error,
      );
      const log = vi.fn();
      const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
      await handleDeliveryBatch(batch, { ...f.deps, log });
      expect(messages[0]!.ack).toHaveBeenCalledTimes(1);
      expect(messages[0]!.retry).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          deliveryId: f.delivery.id,
          result:
            scenario === "decrypt" ? "permanent_failed" : "retryable_failed",
          errorClass: "AccountReconnectWriteError",
        }),
      );
      expect((await f.read()).status).toBe(
        scenario === "decrypt" ? "PERMANENT_FAILED" : "RETRYABLE_FAILED",
      );
    },
  );

  it("acks accepted, duplicate and missing deliveries individually with one safe JSON log each", async () => {
    const f = await deliveryFixture(t.db);
    const log = vi.fn();
    const { batch, messages } = fakeBatch(
      { deliveryId: f.delivery.id },
      { deliveryId: f.delivery.id },
      { deliveryId: "delivery_fake_missing" },
    );
    await handleDeliveryBatch(batch, { ...f.deps, log });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(batch.ackAll).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { deliveryId: f.delivery.id, result: "sent", errorClass: null },
      { deliveryId: f.delivery.id, result: "skipped", errorClass: null },
      {
        deliveryId: "delivery_fake_missing",
        result: "skipped",
        errorClass: null,
      },
    ]);
    const lines = log.mock.calls.flat().join("\n");
    for (const secret of [
      FAKE_KEY,
      FAKE_TOKEN,
      "commenter_fake_name",
      "comment_fake_text",
      "https://example.com/fake-guide",
    ])
      expect(lines).not.toContain(secret);
  });

  it("acks malformed messages without logging their payloads and continues the batch", async () => {
    const f = await deliveryFixture(t.db);
    const log = vi.fn();
    const { batch, messages } = fakeBatch(
      null,
      "raw_fake_payload",
      [],
      {},
      { deliveryId: 5 },
      { deliveryId: "" },
      { deliveryId: "fake\nid" },
      { deliveryId: { accessToken: FAKE_TOKEN } },
      { deliveryId: f.delivery.id },
    );
    await handleDeliveryBatch(batch, { ...f.deps, log });
    expect(log).toHaveBeenCalledTimes(messages.length);
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
      deliveryId: null,
      result: "malformed",
      errorClass: "InvalidMessage",
    });
    expect(log.mock.calls.flat().join("\n")).not.toContain(FAKE_TOKEN);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a read failure before claim with no delay and no raw exception details", async () => {
    const f = await deliveryFixture(t.db);
    const log = vi.fn();
    vi.spyOn(t.db, "select").mockImplementationOnce(() => {
      throw new Error(`Synthetic failure ${FAKE_TOKEN}`);
    });
    const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
    await handleDeliveryBatch(batch, { ...f.deps, log });
    expect(messages[0]!.retry).toHaveBeenCalledExactlyOnceWith();
    expect(messages[0]!.ack).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("QUEUED");
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
      deliveryId: f.delivery.id,
      result: "error",
      errorClass: "BeforeClaimError",
    });
  });

  it.each([1, 1001, 3 * 24 * 60 * 60 * 1000])(
    "retries a deferred row with rounded and bounded delay (%i ms)",
    async (delay) => {
      const f = await deliveryFixture(t.db);
      await t.db
        .update(deliveries)
        .set({ nextAttemptAt: NOW + delay })
        .where(eq(deliveries.id, f.delivery.id));
      const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
      await handleDeliveryBatch(batch, { ...f.deps, log: vi.fn() });
      expect(messages[0]!.retry).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: Math.min(
          MAX_QUEUE_DELAY_SECONDS,
          Math.ceil(delay / 1000),
        ),
      });
      expect(messages[0]!.ack).not.toHaveBeenCalled();
      expect((await f.read()).attemptCount).toBe(0);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("acks a retryable Meta outcome because its next attempt is durably scheduled", async () => {
    const f = await deliveryFixture(t.db, () => rejection(4));
    const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
    await handleDeliveryBatch(batch, { ...f.deps, log: vi.fn() });
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    expect(await f.read()).toMatchObject({
      status: "RETRYABLE_FAILED",
      nextAttemptAt: NOW + 15_000,
    });
  });

  it("acks global pause without consuming the pending row", async () => {
    const f = await deliveryFixture(t.db);
    await t.db
      .update(appSettings)
      .set({ sendsPaused: true })
      .where(eq(appSettings.id, 1));
    const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
    await handleDeliveryBatch(batch, { ...f.deps, log: vi.fn() });
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("QUEUED");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("acks a result persistence failure and never re-dispatches on a duplicate message", async () => {
    const f = await deliveryFixture(t.db);
    const log = vi.fn();
    const { batch, messages } = fakeBatch(
      { deliveryId: f.delivery.id },
      { deliveryId: f.delivery.id },
    );
    vi.spyOn(deliveryWrites, "finishDelivery").mockRejectedValueOnce(
      new Error(`Synthetic write failure ${FAKE_TOKEN}`),
    );
    await handleDeliveryBatch(batch, { ...f.deps, log });
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledTimes(1);
      expect(message.retry).not.toHaveBeenCalled();
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.read()).status).toBe("SENDING");
    expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
      deliveryId: f.delivery.id,
      result: "error",
      errorClass: "ClaimOrProcessingError",
    });
  });

  it("acks an ambiguous claim response and leaves its committed SENDING row for quarantine", async () => {
    const f = await deliveryFixture(t.db);
    const originalClaim = deliveryWrites.claimDelivery;
    vi.spyOn(deliveryWrites, "claimDelivery").mockImplementationOnce(
      async (...args) => {
        await originalClaim(...args);
        throw new Error("Synthetic loss of the claim response");
      },
    );
    const { batch, messages } = fakeBatch({ deliveryId: f.delivery.id });
    await handleDeliveryBatch(batch, { ...f.deps, log: vi.fn() });
    expect(messages[0]!.ack).toHaveBeenCalledTimes(1);
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("SENDING");
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
