import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimStatement,
  pendingDeliveries,
  quarantineStatement,
} from "./deliveries";
import { appSettings, automations, deliveries } from "./schema";
import {
  failureOf,
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

async function insertDelivery(
  automation: { id: string; instagramAccountId: string },
  overrides: Partial<typeof deliveries.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(deliveries)
    .values({
      instagramAccountId: automation.instagramAccountId,
      automationId: automation.id,
      commentId: fakeId("comment"),
      commenterIgsid: fakeId("igsid"),
      source: "webhook",
      status: "RECEIVED",
      ...overrides,
    })
    .returning();
  return row!;
}

describe("deliveries", () => {
  it("allows one delivery per (account, comment)", async () => {
    const account = await insertAccount(t.db);
    const automation = await insertAutomation(t.db, account.id);
    const first = await insertDelivery(automation);

    expect(
      await failureOf(
        insertDelivery(automation, { commentId: first.commentId }),
      ),
    ).toMatch(
      /UNIQUE constraint failed: deliveries\.instagram_account_id, deliveries\.comment_id/,
    );

    // The same comment ID under another account is a different comment.
    const other = await insertAccount(t.db);
    const otherAutomation = await insertAutomation(t.db, other.id);
    await insertDelivery(otherAutomation, { commentId: first.commentId });
  });

  it("lets only one delivery hold a commenter's once-per-user slot", async () => {
    const account = await insertAccount(t.db);
    const automation = await insertAutomation(t.db, account.id);
    const commenter = { commenterIgsid: fakeId("igsid") };

    await insertDelivery(automation, {
      ...commenter,
      countsTowardOncePerUser: true,
    });
    expect(
      await failureOf(
        insertDelivery(automation, {
          ...commenter,
          countsTowardOncePerUser: true,
        }),
      ),
    ).toMatch(
      /UNIQUE constraint failed: deliveries\.automation_id, deliveries\.commenter_igsid/,
    );

    // A later comment that does not take the slot is still recorded.
    const skipped = await insertDelivery(automation, {
      ...commenter,
      status: "SKIPPED",
    });
    expect(skipped.countsTowardOncePerUser).toBe(false);

    // The slot is per automation.
    const otherAutomation = await insertAutomation(t.db, account.id);
    await insertDelivery(otherAutomation, {
      ...commenter,
      countsTowardOncePerUser: true,
    });
  });

  it("rejects a status outside the vocabulary", async () => {
    const account = await insertAccount(t.db);
    const automation = await insertAutomation(t.db, account.id);
    expect(
      await failureOf(
        insertDelivery(automation, { status: "DELIVERED" as never }),
      ),
    ).toMatch(/CHECK constraint failed: deliveries_status/);
  });

  it("rejects a pending delivery the sweep could never see", async () => {
    const account = await insertAccount(t.db);
    const automation = await insertAutomation(t.db, account.id);
    expect(
      await failureOf(insertDelivery(automation, { status: "QUEUED" })),
    ).toMatch(/CHECK constraint failed: deliveries_pending_has_next_attempt/);
    expect(
      await failureOf(insertDelivery(automation, { status: "SENDING" })),
    ).toMatch(/CHECK constraint failed: deliveries_sending_has_claimed_at/);
  });

  it("enforces the account and automation foreign keys", async () => {
    const account = await insertAccount(t.db);
    expect(
      await failureOf(
        insertDelivery({
          id: "automation_fake_missing",
          instagramAccountId: account.id,
        }),
      ),
    ).toMatch(/FOREIGN KEY constraint failed/);
  });
});

describe("automations", () => {
  it("allows one active automation per media item", async () => {
    const account = await insertAccount(t.db);
    const media = { mediaId: fakeId("media") };
    const active = await insertAutomation(t.db, account.id, media);

    expect(await failureOf(insertAutomation(t.db, account.id, media))).toMatch(
      /UNIQUE constraint failed: automations\.instagram_account_id, automations\.media_id/,
    );

    // Inactive ones coexist, and one can take over once the first is paused.
    const paused = await insertAutomation(t.db, account.id, {
      ...media,
      isActive: false,
    });
    await t.db
      .update(automations)
      .set({ isActive: false })
      .where(eq(automations.id, active.id));
    await t.db
      .update(automations)
      .set({ isActive: true })
      .where(eq(automations.id, paused.id));
  });

  it("requires a keyword and match mode for keyword triggers", async () => {
    const account = await insertAccount(t.db);
    expect(
      await failureOf(insertAutomation(t.db, account.id, { keyword: null })),
    ).toMatch(
      /CHECK constraint failed: automations_keyword_trigger_has_keyword/,
    );
    await insertAutomation(t.db, account.id, {
      triggerType: "any",
      keyword: null,
      matchMode: null,
    });
  });

  it("keeps a deleted automation inactive", async () => {
    const account = await insertAccount(t.db);
    expect(
      await failureOf(
        insertAutomation(t.db, account.id, { deletedAt: T0, isActive: true }),
      ),
    ).toMatch(/CHECK constraint failed: automations_deleted_is_inactive/);
  });
});

describe("app_settings", () => {
  it("is seeded with one default row and rejects a second", async () => {
    const rows = await t.db.select().from(appSettings);
    expect(rows).toEqual([
      expect.objectContaining({ id: 1, sendsPaused: false, retentionDays: 30 }),
    ]);
    expect(await failureOf(t.db.insert(appSettings).values({ id: 2 }))).toMatch(
      /CHECK constraint failed: app_settings_single_row/,
    );
  });
});

describe("query plans", () => {
  /** SQLite's plan for a Drizzle query, one line per step. */
  async function plan(query: { toSQL(): { sql: string; params: unknown[] } }) {
    const { sql, params } = query.toSQL();
    const { results } = await t.d1
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((row) => row.detail).join("\n");
  }

  // Each of these runs every minute or on every send; a table scan would
  // spend D1's daily read budget (ADR 0002 gate 2).
  it("finds due deliveries through the partial pending index", async () => {
    const steps = await plan(pendingDeliveries(t.db, { now: T0, limit: 5 }));
    expect(steps).toMatch(/USING INDEX deliveries_pending_idx/);
    expect(steps).not.toMatch(/SCAN deliveries\b(?! USING)/);
  });

  it("finds stale claims through the partial sending index", async () => {
    const steps = await plan(quarantineStatement(t.db, { now: T0 }));
    expect(steps).toMatch(/USING INDEX deliveries_sending_idx/);
  });

  it("counts recent claims through the account claimed-at index", async () => {
    const steps = await plan(
      claimStatement(t.db, "delivery_fake_plan", T0, {
        perHour: 600,
        burstPerMinute: 30,
      }),
    );
    expect(steps).toMatch(/USING INDEX deliveries_account_claimed_at_idx/);
    expect(steps).not.toMatch(/SCAN recent\b(?! USING)/);
  });
});
