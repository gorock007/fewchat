import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { accountByInstagramUserIdQuery } from "../db/accounts";
import { activeAutomationsQuery } from "../db/automations";
import type { Db } from "../db/deliveries";
import * as schema from "../db/schema";
import { appSettings, deliveries, webhookEvents } from "../db/schema";
import { fakeId, insertAccount, insertAutomation } from "../db/test-d1";
import { PRIVATE_REPLY_WINDOW_MS } from "../domain/eligibility";
import { signFakeBody } from "../meta/fixtures";
import { FAKE_ENV, startWorker } from "./harness";

const PATH = "/api/webhooks/instagram";

type Worker = Awaited<ReturnType<typeof startWorker>>;

async function connect(worker: Worker): Promise<Db> {
  return drizzle((await worker.getD1()) as never, { schema });
}

/** A fake connected account with a keyword automation on one media. */
async function setup(db: Db, automation: Partial<schema.NewAutomation> = {}) {
  const account = await insertAccount(db, { instagramUserId: fakeId("ig") });
  const active = await insertAutomation(db, account.id, automation);
  return { account, automation: active };
}

type FakeComment = {
  id?: string;
  mediaId: string;
  fromId?: string;
  text?: string;
  parentId?: string;
};

/** A fact-sheet-shaped payload with synthetic values; `time` in seconds. */
function payload(
  accountId: string,
  comments: FakeComment[],
  time = Math.floor(Date.now() / 1000),
) {
  return {
    object: "instagram",
    entry: [
      {
        id: accountId,
        time,
        changes: comments.map((c) => ({
          field: "comments",
          value: {
            id: c.id ?? fakeId("comment"),
            from: {
              id: c.fromId ?? fakeId("commenter"),
              username: "fake_commenter_example",
            },
            text: c.text ?? "GUIDE please",
            media: { id: c.mediaId, media_product_type: "REELS" },
            ...(c.parentId ? { parent_id: c.parentId } : {}),
          },
        })),
      },
    ],
  };
}

async function post(worker: Worker, body: string, signature?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (signature !== undefined) headers["x-hub-signature-256"] = signature;
  return worker.fetch(PATH, { method: "POST", headers, body });
}

async function postSigned(worker: Worker, value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  return post(worker, body, await signFakeBody(body));
}

/** Signed POST that must be accepted, so a "nothing written" check cannot pass on a 500. */
async function postOk(worker: Worker, value: unknown) {
  const response = await postSigned(worker, value);
  expect(response.status).toBe(200);
  return response;
}

async function rowsFor(db: Db, accountId: string) {
  const events = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.instagramAccountId, accountId));
  const delivered = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.instagramAccountId, accountId));
  return { events, deliveries: delivered };
}

describe("webhook", () => {
  let worker: Worker;
  let db: Db;

  beforeAll(async () => {
    worker = await startWorker({ spyQueue: true });
    db = await connect(worker);
  });

  afterAll(async () => {
    await worker?.close();
  });

  beforeEach(() => {
    worker.queue.calls.length = 0;
    worker.queue.failSends = false;
  });

  describe("GET verification", () => {
    const verify = (token: string) =>
      worker.fetch(
        `${PATH}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`,
      );

    it("echoes the challenge for the right token", async () => {
      const response = await verify(FAKE_ENV.META_WEBHOOK_VERIFY_TOKEN);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("1158201444");
    });

    it("refuses a wrong token", async () => {
      const response = await verify("FAKE_WRONG_TOKEN");
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
    });
  });

  describe("POST rejections", () => {
    it("refuses a missing signature", async () => {
      const { account, automation } = await setup(db);
      const body = JSON.stringify(
        payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
      );
      expect((await post(worker, body)).status).toBe(401);
      expect(await rowsFor(db, account.id)).toEqual({
        events: [],
        deliveries: [],
      });
    });

    it("refuses a body changed after signing", async () => {
      const { account, automation } = await setup(db);
      const body = JSON.stringify(
        payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
      );
      const signature = await signFakeBody(body);
      const tampered = JSON.stringify(JSON.parse(body), null, 1);
      expect((await post(worker, tampered, signature)).status).toBe(401);
      expect((await rowsFor(db, account.id)).deliveries).toEqual([]);
    });

    it("refuses a 33 KB body with 413", async () => {
      const body = JSON.stringify({
        object: "instagram",
        pad: "x".repeat(33 * 1024),
      });
      expect((await postSigned(worker, body)).status).toBe(413);
    });

    it("refuses malformed JSON with 400", async () => {
      expect((await postSigned(worker, '{"object":"instagram",')).status).toBe(
        400,
      );
    });
  });

  describe("POST ingest", () => {
    it("records a matching comment as one event and a QUEUED delivery, and enqueues it", async () => {
      const { account, automation } = await setup(db);
      const response = await postSigned(
        worker,
        payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
      );
      expect(response.status).toBe(200);

      const rows = await rowsFor(db, account.id);
      expect(rows.events).toHaveLength(1);
      expect(rows.deliveries).toHaveLength(1);
      const [delivery] = rows.deliveries;
      expect(delivery).toMatchObject({
        automationId: automation.id,
        status: "QUEUED",
        source: "webhook",
        commentTextExcerpt: "GUIDE please",
        countsTowardOncePerUser: true,
      });
      expect(rows.events[0]!.eventKey).toBe(`comments:${delivery!.commentId}`);
      expect(worker.queue.calls).toEqual([[{ deliveryId: delivery!.id }]]);
    });

    it("stores the notification time as the comment time", async () => {
      const { account, automation } = await setup(db);
      const time = Math.floor(Date.now() / 1000) - 60;
      await postSigned(
        worker,
        payload(
          account.instagramUserId,
          [{ mediaId: automation.mediaId }],
          time,
        ),
      );
      const [delivery] = (await rowsFor(db, account.id)).deliveries;
      expect(delivery!.commentCreatedAt).toBe(time * 1000);
    });

    it("treats a redelivery as a no-op: no new rows, no message", async () => {
      const { account, automation } = await setup(db);
      const body = payload(account.instagramUserId, [
        { mediaId: automation.mediaId },
      ]);
      await postSigned(worker, body);
      const first = await rowsFor(db, account.id);
      worker.queue.calls.length = 0;

      expect((await postSigned(worker, body)).status).toBe(200);
      expect(await rowsFor(db, account.id)).toEqual(first);
      expect(worker.queue.calls).toEqual([]);
    });

    it("records two comments in one payload in one enqueue call", async () => {
      const { account, automation } = await setup(db);
      await postSigned(
        worker,
        payload(account.instagramUserId, [
          { mediaId: automation.mediaId },
          { mediaId: automation.mediaId },
        ]),
      );
      const rows = await rowsFor(db, account.id);
      expect(rows.events).toHaveLength(2);
      expect(rows.deliveries.map((d) => d.status)).toEqual([
        "QUEUED",
        "QUEUED",
      ]);
      expect(worker.queue.calls).toHaveLength(1);
      expect(worker.queue.calls[0]).toEqual(
        expect.arrayContaining(
          rows.deliveries.map((d) => ({ deliveryId: d.id })),
        ),
      );
    });

    it("records a repeat commenter as SKIPPED once_per_user, without a message", async () => {
      const { account, automation } = await setup(db);
      const fromId = fakeId("commenter");
      await postSigned(
        worker,
        payload(account.instagramUserId, [
          { mediaId: automation.mediaId, fromId },
          { mediaId: automation.mediaId, fromId },
        ]),
      );
      const rows = await rowsFor(db, account.id);
      expect(
        rows.deliveries.map((d) => [d.status, d.skipReason]).sort(),
      ).toEqual([
        ["QUEUED", null],
        ["SKIPPED", "once_per_user"],
      ]);
      expect(worker.queue.calls).toHaveLength(1);
      expect(worker.queue.calls[0]).toHaveLength(1);
    });

    it("records a matching comment past the window as SKIPPED outside_window, without a message", async () => {
      const { account, automation } = await setup(db);
      const old = Math.floor((Date.now() - PRIVATE_REPLY_WINDOW_MS) / 1000);
      await postSigned(
        worker,
        payload(
          account.instagramUserId,
          [{ mediaId: automation.mediaId }],
          old,
        ),
      );
      const rows = await rowsFor(db, account.id);
      expect(rows.events).toHaveLength(1);
      expect(rows.deliveries).toMatchObject([
        { status: "SKIPPED", skipReason: "outside_window" },
      ]);
      expect(worker.queue.calls).toEqual([]);
    });

    it("still queues and enqueues while sends are paused", async () => {
      const { account, automation } = await setup(db);
      await db.update(appSettings).set({ sendsPaused: true });
      try {
        await postSigned(
          worker,
          payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
        );
      } finally {
        await db.update(appSettings).set({ sendsPaused: false });
      }
      const rows = await rowsFor(db, account.id);
      expect(rows.deliveries).toMatchObject([{ status: "QUEUED" }]);
      expect(worker.queue.calls).toHaveLength(1);
    });

    it("answers 200 and keeps the delivery QUEUED when the queue send throws", async () => {
      const { account, automation } = await setup(db);
      worker.queue.failSends = true;
      const response = await postSigned(
        worker,
        payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
      );
      expect(response.status).toBe(200);
      expect(worker.queue.calls).toEqual([]);
      const rows = await rowsFor(db, account.id);
      expect(rows.deliveries).toMatchObject([
        { status: "QUEUED", nextAttemptAt: expect.any(Number) },
      ]);
    });

    describe("writes nothing for", () => {
      it("a comment by the account itself", async () => {
        const { account, automation } = await setup(db, {
          triggerType: "any",
          keyword: null,
          matchMode: null,
        });
        await postOk(
          worker,
          payload(account.instagramUserId, [
            { mediaId: automation.mediaId, fromId: account.instagramUserId },
          ]),
        );
        expect(await rowsFor(db, account.id)).toEqual({
          events: [],
          deliveries: [],
        });
      });

      it("a nested reply", async () => {
        const { account, automation } = await setup(db);
        await postOk(
          worker,
          payload(account.instagramUserId, [
            { mediaId: automation.mediaId, parentId: fakeId("comment") },
          ]),
        );
        expect(await rowsFor(db, account.id)).toEqual({
          events: [],
          deliveries: [],
        });
      });

      it("media with no active automation", async () => {
        const { account } = await setup(db);
        const inactive = await insertAutomation(db, account.id, {
          isActive: false,
        });
        await postOk(
          worker,
          payload(account.instagramUserId, [
            { mediaId: fakeId("media") },
            { mediaId: inactive.mediaId },
          ]),
        );
        expect(await rowsFor(db, account.id)).toEqual({
          events: [],
          deliveries: [],
        });
      });

      it("text the trigger does not match", async () => {
        const { account, automation } = await setup(db);
        await postOk(
          worker,
          payload(account.instagramUserId, [
            { mediaId: automation.mediaId, text: "GUIDELINES?" },
          ]),
        );
        expect(await rowsFor(db, account.id)).toEqual({
          events: [],
          deliveries: [],
        });
      });

      it("an unknown or disconnected account", async () => {
        const { account, automation } = await setup(db);
        await db
          .update(schema.instagramAccounts)
          .set({ connectionStatus: "disconnected" })
          .where(eq(schema.instagramAccounts.id, account.id));
        const unknown = await postOk(
          worker,
          payload(fakeId("ig"), [{ mediaId: automation.mediaId }]),
        );
        const disconnected = await postOk(
          worker,
          payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
        );
        expect([unknown.status, disconnected.status]).toEqual([200, 200]);
        expect(await rowsFor(db, account.id)).toEqual({
          events: [],
          deliveries: [],
        });
        expect(worker.queue.calls).toEqual([]);
      });
    });
  });

  describe("lookups", () => {
    async function plan(query: {
      toSQL(): { sql: string; params: unknown[] };
    }) {
      const { sql: text, params } = query.toSQL();
      const { results } = await (
        await worker.getD1()
      )
        .prepare(`EXPLAIN QUERY PLAN ${text}`)
        .bind(...params)
        .all<{ detail: string }>();
      return results.map((row) => row.detail).join("\n");
    }

    // Every webhook runs these; a scan would spend D1's read budget.
    it("finds the account by its unique Instagram user ID", async () => {
      const steps = await plan(accountByInstagramUserIdQuery(db, "ig_plan"));
      expect(steps).toMatch(
        /USING INDEX instagram_accounts_instagram_user_id_unique/,
      );
    });

    it("finds automations through the one-active-per-media index", async () => {
      const steps = await plan(
        activeAutomationsQuery(db, "ig_plan", ["media_a", "media_b"]),
      );
      expect(steps).toMatch(/USING INDEX automations_one_active_per_media/);
      expect(steps).not.toMatch(
        /SCAN (automations|instagram_accounts)\b(?! USING)/,
      );
    });
  });

  it("no longer treats /webhook as a webhook", async () => {
    // Not worker-first now, so assets are checked first. With no
    // `not_found_handling`, a miss still reaches the Worker: Hono's 404.
    const { account, automation } = await setup(db);
    const body = JSON.stringify(
      payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
    );
    const response = await worker.fetch("/webhook", {
      method: "POST",
      headers: { "x-hub-signature-256": await signFakeBody(body) },
      body,
    });
    expect(response.status).toBe(404);
    expect(await rowsFor(db, account.id)).toEqual({
      events: [],
      deliveries: [],
    });
  });
});

describe("webhook when D1 fails", () => {
  let worker: Worker;

  beforeAll(async () => {
    worker = await startWorker({ spyQueue: true });
  });

  afterAll(async () => {
    await worker?.close();
  });

  it("answers 500 so Meta redelivers, and enqueues nothing", async () => {
    const db = await connect(worker);
    const { account, automation } = await setup(db);
    // Lookups still work; the write batch cannot.
    await db.run(sql`drop table ${webhookEvents}`);

    const response = await postSigned(
      worker,
      payload(account.instagramUserId, [{ mediaId: automation.mediaId }]),
    );
    expect(response.status).toBe(500);
    expect(await db.select().from(deliveries)).toEqual([]);
    expect(worker.queue.calls).toEqual([]);
  });
});
