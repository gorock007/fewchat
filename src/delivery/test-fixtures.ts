// Synthetic D1 fixtures shared by the processor and consumer tests only.
import { eq } from "drizzle-orm";
import { vi } from "vitest";

import { encryptToken } from "../crypto/tokens";
import type { Db } from "../db/deliveries";
import { deliveries, instagramAccounts, type NewDelivery } from "../db/schema";
import { fakeId, insertAccount, insertAutomation } from "../db/test-d1";
import { createMetaClient } from "../meta/client";
import type { DeliveryDependencies } from "./process";

export const NOW = 1_800_000_000_000;
export const FAKE_KEY = "FAKE_PROCESSOR_ENCRYPTION_KEY";
export const FAKE_TOKEN = "FAKE_PROCESSOR_ACCESS_TOKEN";
export const accepted = () =>
  Response.json({
    recipient_id: "recipient_fake_1",
    message_id: "message_fake_1",
  });
export const rejection = (code: number, headers?: Record<string, string>) =>
  Response.json(
    { error: { code, message: "Synthetic provider rejection" } },
    { status: 400, headers },
  );

export async function deliveryFixture(
  db: Db,
  response: (request: Request) => Response | Promise<Response> = accepted,
) {
  const account = await insertAccount(db);
  const encryptedAccessToken = await encryptToken(FAKE_TOKEN, {
    encryptionKey: FAKE_KEY,
    instagramAccountId: account.id,
  });
  await db
    .update(instagramAccounts)
    .set({ encryptedAccessToken })
    .where(eq(instagramAccounts.id, account.id));
  const automation = await insertAutomation(db, account.id, {
    dmTemplate: "Hello {username}! {keyword}: {resource_url}",
  });
  const insert = async (overrides: Partial<NewDelivery> = {}) => {
    const [delivery] = await db
      .insert(deliveries)
      .values({
        instagramAccountId: account.id,
        automationId: automation.id,
        commentId: fakeId("comment"),
        commenterIgsid: fakeId("commenter"),
        commenterUsername: "commenter_fake_name",
        commentTextExcerpt: "comment_fake_text",
        commentCreatedAt: NOW - 60_000,
        status: "QUEUED",
        source: "webhook",
        countsTowardOncePerUser: true,
        nextAttemptAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
      })
      .returning();
    return delivery!;
  };
  const delivery = await insert();
  const fetch = vi.fn(async (request: Request) => response(request));
  const deps: DeliveryDependencies = {
    db,
    meta: createMetaClient({
      fetch,
      baseUrl: "https://graph.example.test",
      version: "v99.0",
    }),
    tokenEncryptionKey: FAKE_KEY,
    limits: { perHour: 600, burstPerMinute: 30 },
    now: () => NOW,
    random: () => 0.5,
  };
  const read = async () =>
    (
      await db.select().from(deliveries).where(eq(deliveries.id, delivery.id))
    )[0]!;
  const readAccount = async () =>
    (
      await db
        .select()
        .from(instagramAccounts)
        .where(eq(instagramAccounts.id, account.id))
    )[0]!;
  return {
    account,
    automation,
    delivery,
    insert,
    fetch,
    deps,
    read,
    readAccount,
  };
}
