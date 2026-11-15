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

import { quarantineStaleSending } from "../db/deliveries";
import { encryptToken } from "../crypto/tokens";
import { markNeedsReconnect } from "../db/accounts-write";
import * as deliveryWrites from "../db/deliveries";
import {
  appSettings,
  automations,
  deliveries,
  instagramAccounts,
} from "../db/schema";
import { startTestD1, type TestD1 } from "../db/test-d1";
import { PRIVATE_REPLY_WINDOW_MS } from "../domain/eligibility";
import { createMetaClient } from "../meta/client";
import {
  BeforeClaimError,
  MAX_SEND_ATTEMPTS,
  processDelivery,
} from "./process";
import {
  accepted,
  deliveryFixture,
  FAKE_KEY,
  FAKE_TOKEN,
  NOW,
  rejection,
} from "./test-fixtures";

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

describe("processDelivery", () => {
  it.each(["", undefined, null, " \t"])(
    "rejects missing/empty deployment key %j before any claim or mutation",
    async (key) => {
      const f = await deliveryFixture(t.db);
      const before = await f.read();
      const accountBefore = await f.readAccount();
      const claim = vi.spyOn(deliveryWrites, "claimDelivery");
      await expect(
        processDelivery(f.delivery.id, {
          ...f.deps,
          tokenEncryptionKey: key as string,
        }),
      ).rejects.toThrow(BeforeClaimError);
      expect(claim).not.toHaveBeenCalled();
      expect(f.fetch).not.toHaveBeenCalled();
      expect(await f.read()).toEqual(before);
      expect(await f.readAccount()).toEqual(accountBefore);
    },
  );

  it.each([
    "decrypt",
    "token_invalid",
    "permission_denied",
    "final_token_invalid",
  ])(
    "persists %s outcome even if the subsequent account write fails",
    async (scenario) => {
      const f = await deliveryFixture(t.db, () =>
        rejection(scenario === "permission_denied" ? 10 : 190),
      );
      if (scenario === "decrypt") f.deps.tokenEncryptionKey = "FAKE_WRONG_KEY";
      if (scenario === "final_token_invalid")
        await t.db
          .update(deliveries)
          .set({ attemptCount: MAX_SEND_ATTEMPTS - 1 })
          .where(eq(deliveries.id, f.delivery.id));
      const permanent =
        scenario === "decrypt" || scenario === "final_token_invalid";
      const accountBefore = await f.readAccount();
      await t.d1
        .prepare(
          "CREATE TRIGGER fake_fail_reconnect BEFORE UPDATE OF connection_status ON instagram_accounts WHEN NEW.connection_status = 'needs_reconnect' BEGIN SELECT RAISE(ABORT, 'synthetic account write failure'); END",
        )
        .run();
      try {
        expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
          result: permanent ? "permanent_failed" : "retryable_failed",
          ...(permanent ? {} : { retryAt: NOW + 15_000 }),
          errorClass: "AccountReconnectWriteError",
        });
        expect(await f.read()).toMatchObject({
          status: permanent ? "PERMANENT_FAILED" : "RETRYABLE_FAILED",
          nextAttemptAt: permanent ? null : NOW + 15_000,
          countsTowardOncePerUser: !permanent,
        });
        expect(await f.readAccount()).toEqual(accountBefore);
        expect(f.fetch).toHaveBeenCalledTimes(scenario === "decrypt" ? 0 : 1);
        expect(
          await quarantineStaleSending(t.db, { now: NOW + 60_001 }),
        ).not.toContain(f.delivery.id);
      } finally {
        await t.d1.prepare("DROP TRIGGER fake_fail_reconnect").run();
      }
    },
  );

  it("does not let a stale token rejection overwrite a reconnect with a new ciphertext", async () => {
    const f = await deliveryFixture(t.db);
    const encryptedAccessToken = await encryptToken(
      "FAKE_RECONNECTED_ACCESS_TOKEN",
      {
        encryptionKey: FAKE_KEY,
        instagramAccountId: f.account.id,
      },
    );
    f.fetch.mockImplementationOnce(async () => {
      await t.db
        .update(instagramAccounts)
        .set({
          encryptedAccessToken,
          connectionStatus: "connected",
          updatedAt: NOW + 1,
        })
        .where(eq(instagramAccounts.id, f.account.id));
      return rejection(190);
    });
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "retryable_failed",
      retryAt: NOW + 15_000,
    });
    expect(await f.readAccount()).toMatchObject({
      encryptedAccessToken,
      connectionStatus: "connected",
      updatedAt: NOW + 1,
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite newly stored credentials when the delivery used a null ciphertext", async () => {
    const f = await deliveryFixture(t.db);
    const before = await f.readAccount();
    await markNeedsReconnect(t.db, f.account.id, NOW, null);
    expect(await f.readAccount()).toEqual(before);
  });

  it("sends one private reply by comment ID and persists accepted IDs; a duplicate skips", async () => {
    const f = await deliveryFixture(t.db);
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "sent",
    });
    expect(await f.read()).toMatchObject({
      status: "SENT",
      attemptCount: 1,
      claimedAt: NOW,
      sentAt: NOW,
      metaMessageId: "message_fake_1",
      metaRecipientId: "recipient_fake_1",
      countsTowardOncePerUser: true,
    });
    const request = f.fetch.mock.calls[0]![0];
    expect(request.url).toBe(
      `https://graph.example.test/v99.0/${f.account.instagramUserId}/messages`,
    );
    expect(await request.json()).toEqual({
      recipient: { comment_id: f.delivery.commentId },
      message: {
        text: "Hello commenter_fake_name! guide: https://example.com/fake-guide",
      },
    });
    expect(request.headers.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "skipped",
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["transport", "5xx", "malformed success"])(
    "quarantines %s and never resends it",
    async (scenario) => {
      const f = await deliveryFixture(t.db, () => {
        if (scenario === "transport")
          throw new Error("Synthetic transport loss");
        return scenario === "5xx"
          ? new Response("Synthetic failure", { status: 503 })
          : Response.json({ recipient_id: "recipient_fake_1" });
      });
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "unknown",
      });
      expect(await f.read()).toMatchObject({
        status: "DELIVERY_UNKNOWN",
        countsTowardOncePerUser: true,
      });
      await processDelivery(f.delivery.id, f.deps);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("honors Retry-After and defers early duplicate messages without another attempt", async () => {
    const f = await deliveryFixture(t.db, () =>
      rejection(4, { "Retry-After": "120" }),
    );
    const retryAt = NOW + 120_000;
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "retryable_failed",
      retryAt,
    });
    expect(await f.read()).toMatchObject({
      status: "RETRYABLE_FAILED",
      nextAttemptAt: retryAt,
      attemptCount: 1,
      countsTowardOncePerUser: true,
    });
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "deferred",
      retryAt,
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.deps.now = () => retryAt;
    f.fetch.mockImplementationOnce(async () => accepted());
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "sent",
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a known pre-dispatch construction failure without fetching", async () => {
    const f = await deliveryFixture(t.db);
    f.deps.meta = createMetaClient({
      fetch: f.fetch,
      baseUrl: "https://graph.example.test",
      version: "invalid/version",
    });
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "retryable_failed",
      retryAt: NOW + 15_000,
    });
    expect(await f.read()).toMatchObject({
      status: "RETRYABLE_FAILED",
      lastErrorCategory: "not_sent",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([190, 10])(
    "marks the account needs_reconnect and backs off rejection code %i",
    async (code) => {
      const f = await deliveryFixture(t.db, () => rejection(code));
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "retryable_failed",
        retryAt: NOW + 15_000,
      });
      expect(await f.readAccount()).toMatchObject({
        connectionStatus: "needs_reconnect",
      });
      expect(await f.read()).toMatchObject({
        status: "RETRYABLE_FAILED",
        countsTowardOncePerUser: true,
      });
      f.deps.now = () => NOW + 30_000;
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "paused",
      });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([368, 100])(
    "permanently fails rejection code %i and releases the slot",
    async (code) => {
      const f = await deliveryFixture(t.db, () => rejection(code));
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "permanent_failed",
      });
      expect(await f.read()).toMatchObject({
        status: "PERMANENT_FAILED",
        countsTowardOncePerUser: false,
      });
      await expect(
        f.insert({ commenterIgsid: f.delivery.commenterIgsid }),
      ).resolves.toMatchObject({ status: "QUEUED" });
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("maps the reserved ineligible outcome without inventing a Meta error code", async () => {
    const f = await deliveryFixture(t.db);
    f.deps.meta = {
      sendPrivateReply: vi
        .fn()
        .mockResolvedValue({ kind: "ineligible", code: null }),
    };
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "permanent_failed",
    });
    expect(await f.read()).toMatchObject({
      countsTowardOncePerUser: false,
      lastErrorCategory: "ineligible",
    });
  });

  it.each([4, 190, 10])(
    "makes the fifth retryable rejection terminal (code %i)",
    async (code) => {
      const f = await deliveryFixture(t.db, () => rejection(code));
      await t.db
        .update(deliveries)
        .set({
          attemptCount: MAX_SEND_ATTEMPTS - 1,
          status: "RETRYABLE_FAILED",
        })
        .where(eq(deliveries.id, f.delivery.id));
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "permanent_failed",
      });
      expect(await f.read()).toMatchObject({
        status: "PERMANENT_FAILED",
        attemptCount: 5,
        countsTowardOncePerUser: false,
        nextAttemptAt: null,
      });
      if (code !== 4)
        expect((await f.readAccount()).connectionStatus).toBe(
          "needs_reconnect",
        );
      expect(f.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an uncertain fifth attempt UNKNOWN with its slot", async () => {
    const f = await deliveryFixture(
      t.db,
      () => new Response(null, { status: 503 }),
    );
    await t.db
      .update(deliveries)
      .set({ attemptCount: 4 })
      .where(eq(deliveries.id, f.delivery.id));
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "unknown",
    });
    expect((await f.read()).countsTowardOncePerUser).toBe(true);
  });

  it.each(["global", "needs_reconnect", "disconnected"] as const)(
    "does no writes or sends when %s blocks processing",
    async (gate) => {
      const f = await deliveryFixture(t.db);
      if (gate === "global")
        await t.db
          .update(appSettings)
          .set({ sendsPaused: true })
          .where(eq(appSettings.id, 1));
      else
        await t.db
          .update(instagramAccounts)
          .set({ connectionStatus: gate })
          .where(eq(instagramAccounts.id, f.account.id));
      const before = await f.read();
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "paused",
      });
      expect(await f.read()).toEqual(before);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "old",
    "margin boundary",
    "missing timestamp",
    "inactive",
    "deleted",
  ])("expires %s before claiming and releases the slot", async (reason) => {
    const f = await deliveryFixture(t.db);
    if (reason === "inactive" || reason === "deleted")
      await t.db
        .update(automations)
        .set({ isActive: false, deletedAt: reason === "deleted" ? NOW : null })
        .where(eq(automations.id, f.automation.id));
    else
      await t.db
        .update(deliveries)
        .set({
          commentCreatedAt:
            reason === "missing timestamp"
              ? null
              : NOW -
                PRIVATE_REPLY_WINDOW_MS +
                (reason === "margin boundary" ? 3_600_000 : 0),
        })
        .where(eq(deliveries.id, f.delivery.id));
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "expired",
    });
    expect(await f.read()).toMatchObject({
      status: "EXPIRED",
      attemptCount: 0,
      claimedAt: null,
      countsTowardOncePerUser: false,
    });
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(
      f.insert({ commenterIgsid: f.delivery.commenterIgsid }),
    ).resolves.toBeDefined();
  });

  it.each(["hour", "minute"])(
    "defers atomically refused %s limits without an attempt",
    async (window) => {
      const f = await deliveryFixture(t.db);
      await f.insert({ status: "SENT", claimedAt: NOW - 1_000 });
      f.deps.limits = {
        perHour: window === "hour" ? 1 : 600,
        burstPerMinute: window === "minute" ? 1 : 30,
      };
      const retryAt = NOW - 1_000 + (window === "hour" ? 3_600_000 : 60_000);
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "deferred",
        retryAt,
      });
      expect(await f.read()).toMatchObject({
        status: "QUEUED",
        nextAttemptAt: retryAt,
        attemptCount: 0,
        claimedAt: null,
      });
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong key", "missing envelope"])(
    "fails %s permanently and asks for reconnect without sending",
    async (reason) => {
      const f = await deliveryFixture(t.db);
      if (reason === "wrong key") f.deps.tokenEncryptionKey = "FAKE_WRONG_KEY";
      else
        await t.db
          .update(instagramAccounts)
          .set({ encryptedAccessToken: null })
          .where(eq(instagramAccounts.id, f.account.id));
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "permanent_failed",
      });
      expect(await f.read()).toMatchObject({
        status: "PERMANENT_FAILED",
        countsTowardOncePerUser: false,
        lastErrorCategory: "token_decrypt_failed",
      });
      expect((await f.readAccount()).connectionStatus).toBe("needs_reconnect");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "bad {placeholder}",
    "x".repeat(1000) + "{resource_url}",
    "😀".repeat(250) + "{resource_url}",
  ])(
    "rejects invalid or oversized rendered templates without sending",
    async (dmTemplate) => {
      const f = await deliveryFixture(t.db);
      await t.db
        .update(automations)
        .set({ dmTemplate })
        .where(eq(automations.id, f.automation.id));
      expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
        result: "permanent_failed",
      });
      expect(await f.read()).toMatchObject({
        countsTowardOncePerUser: false,
        lastErrorCategory: "template_invalid",
      });
      expect((await f.readAccount()).connectionStatus).toBe("connected");
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );

  it("propagates a D1 result-write failure after exactly one send; quarantine never retries it", async () => {
    const f = await deliveryFixture(t.db);
    await t.d1
      .prepare(
        "CREATE TRIGGER fake_fail_sent BEFORE UPDATE OF status ON deliveries WHEN NEW.status = 'SENT' BEGIN SELECT RAISE(ABORT, 'synthetic result write failure'); END",
      )
      .run();
    try {
      await expect(processDelivery(f.delivery.id, f.deps)).rejects.toThrow();
      expect(await f.read()).toMatchObject({
        status: "SENDING",
        attemptCount: 1,
      });
      await processDelivery(f.delivery.id, f.deps);
      expect(
        await quarantineStaleSending(t.db, { now: NOW + 60_001 }),
      ).toContain(f.delivery.id);
      await processDelivery(f.delivery.id, f.deps);
      expect((await f.read()).status).toBe("DELIVERY_UNKNOWN");
      expect(f.fetch).toHaveBeenCalledTimes(1);
    } finally {
      await t.d1.prepare("DROP TRIGGER fake_fail_sent").run();
    }
  });

  it("records a late success even if the sweep quarantined its in-flight claim", async () => {
    const f = await deliveryFixture(t.db, async () => {
      await quarantineStaleSending(t.db, { now: NOW + 60_001 });
      return accepted();
    });
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "sent",
    });
    expect((await f.read()).status).toBe("SENT");
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("allows only one of two concurrent callers to send", async () => {
    const f = await deliveryFixture(t.db);
    const results = await Promise.all([
      processDelivery(f.delivery.id, f.deps),
      processDelivery(f.delivery.id, f.deps),
    ]);
    expect(results.map((r) => r.result).sort()).toEqual(["sent", "skipped"]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect((await f.read()).attemptCount).toBe(1);
  });

  it("a stale concurrent caller cannot bypass backoff after the first caller's retryable rejection", async () => {
    const f = await deliveryFixture(t.db, () => rejection(4));
    const originalClaim = deliveryWrites.claimDelivery;
    let entered = 0;
    let bothEntered!: () => void;
    let firstFinished!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      firstFinished = resolve;
    });
    vi.spyOn(deliveryWrites, "claimDelivery").mockImplementation(
      async (...args) => {
        const order = ++entered;
        if (order === 2) bothEntered();
        await ready;
        if (order === 2) await finished;
        return originalClaim(...args);
      },
    );
    // Both callers have already read the original QUEUED row before either
    // claims it. Hold the second claim until the first persists its backoff.
    const first = processDelivery(f.delivery.id, f.deps).finally(firstFinished);
    const second = processDelivery(f.delivery.id, f.deps);
    const results = await Promise.all([first, second]);
    expect(results.map((r) => r.result).sort()).toEqual([
      "deferred",
      "retryable_failed",
    ]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(await f.read()).toMatchObject({
      status: "RETRYABLE_FAILED",
      attemptCount: 1,
      nextAttemptAt: NOW + 15_000,
    });
  });

  it("skips a missing delivery and leaves non-pending rows unchanged", async () => {
    const f = await deliveryFixture(t.db);
    expect(await processDelivery("delivery_fake_missing", f.deps)).toEqual({
      result: "skipped",
    });
    await t.db
      .update(deliveries)
      .set({ status: "SKIPPED" })
      .where(eq(deliveries.id, f.delivery.id));
    const before = await f.read();
    expect(await processDelivery(f.delivery.id, f.deps)).toEqual({
      result: "skipped",
    });
    expect(await f.read()).toEqual(before);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("identifies read failures as before-claim without exposing the raw exception", async () => {
    const f = await deliveryFixture(t.db);
    vi.spyOn(t.db, "select").mockImplementationOnce(() => {
      throw new Error(FAKE_TOKEN);
    });
    await expect(processDelivery(f.delivery.id, f.deps)).rejects.toThrow(
      BeforeClaimError,
    );
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.read()).status).toBe("QUEUED");
  });
});
