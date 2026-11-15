import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { appSettings, automations, deliveries } from "./schema";
import {
  createTestDatabase,
  insertAccount,
  insertAutomation,
  insertDelivery,
  type TestDatabase,
} from "./test-utils";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.teardown();
});

/** Drizzle wraps driver errors; the PostgreSQL error is the cause. */
async function violation(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the query to fail").toBeDefined();
  const cause = (
    error as { cause?: { code?: string; constraint_name?: string } }
  ).cause;
  return { code: cause?.code, constraint: cause?.constraint_name };
}

describe("deliveries", () => {
  it("allows one delivery per (account, comment)", async () => {
    const account = await insertAccount(testDb.db);
    const automation = await insertAutomation(testDb.db, account.id);
    const first = await insertDelivery(testDb.db, automation, {
      commentId: "comment_fake_dup",
    });

    expect(
      await violation(
        insertDelivery(testDb.db, automation, {
          commentId: "comment_fake_dup",
        }),
      ),
    ).toEqual({
      code: "23505",
      constraint: "deliveries_account_comment_unique",
    });

    // The same comment ID under another account is a different comment.
    const otherAccount = await insertAccount(testDb.db);
    const otherAutomation = await insertAutomation(testDb.db, otherAccount.id);
    await insertDelivery(testDb.db, otherAutomation, {
      commentId: first.commentId,
    });
  });

  it("lets only one delivery claim a commenter's once-per-user slot", async () => {
    const account = await insertAccount(testDb.db);
    const automation = await insertAutomation(testDb.db, account.id);
    const commenter = { commenterIgsid: "igsid_fake_repeat" };

    await insertDelivery(testDb.db, automation, {
      ...commenter,
      countsTowardOncePerUser: true,
    });
    expect(
      await violation(
        insertDelivery(testDb.db, automation, {
          ...commenter,
          countsTowardOncePerUser: true,
        }),
      ),
    ).toEqual({ code: "23505", constraint: "deliveries_once_per_user_unique" });

    // Later comments by the same person are recorded as SKIPPED without the slot.
    const skipped = await insertDelivery(testDb.db, automation, {
      ...commenter,
      status: "SKIPPED",
      countsTowardOncePerUser: false,
    });
    expect(skipped.status).toBe("SKIPPED");

    // The slot is per automation.
    const otherAutomation = await insertAutomation(testDb.db, account.id);
    await insertDelivery(testDb.db, otherAutomation, {
      ...commenter,
      countsTowardOncePerUser: true,
    });
  });

  it("rejects one of two concurrent slot claims", async () => {
    const account = await insertAccount(testDb.db);
    const automation = await insertAutomation(testDb.db, account.id);
    const [a, b] = [testDb.connect(), testDb.connect()];

    const results = await Promise.allSettled(
      [a, b].map((db) =>
        db.transaction(async (tx) => {
          await tx.insert(deliveries).values({
            instagramAccountId: account.id,
            automationId: automation.id,
            commentId: `comment_fake_${Math.random()}`,
            commenterIgsid: "igsid_fake_racer",
            source: "webhook",
            countsTowardOncePerUser: true,
          });
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
  });
});

describe("automations", () => {
  it("allows one active automation per media item", async () => {
    const account = await insertAccount(testDb.db);
    const media = { mediaId: "media_fake_shared" };
    const active = await insertAutomation(testDb.db, account.id, media);

    expect(
      await violation(insertAutomation(testDb.db, account.id, media)),
    ).toEqual({
      code: "23505",
      constraint: "automations_one_active_per_media",
    });

    // Inactive ones can coexist, and one can take over once the first is paused.
    const paused = await insertAutomation(testDb.db, account.id, {
      ...media,
      isActive: false,
    });
    await testDb.db
      .update(automations)
      .set({ isActive: false })
      .where(eq(automations.id, active.id));
    await testDb.db
      .update(automations)
      .set({ isActive: true })
      .where(eq(automations.id, paused.id));
  });

  it("requires a keyword and match mode for keyword triggers", async () => {
    const account = await insertAccount(testDb.db);
    expect(
      await violation(
        insertAutomation(testDb.db, account.id, { keyword: null }),
      ),
    ).toEqual({
      code: "23514",
      constraint: "automations_keyword_trigger_has_keyword",
    });
    await insertAutomation(testDb.db, account.id, {
      triggerType: "any",
      keyword: null,
      matchMode: null,
    });
  });
});

describe("app_settings", () => {
  it("is seeded with one default row and rejects a second", async () => {
    const rows = await testDb.db.select().from(appSettings);
    expect(rows).toEqual([
      expect.objectContaining({ id: 1, sendsPaused: false, retentionDays: 30 }),
    ]);
    expect(
      await violation(testDb.db.insert(appSettings).values({ id: 2 })),
    ).toEqual({ code: "23514", constraint: "app_settings_single_row" });
  });
});
