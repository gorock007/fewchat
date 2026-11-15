// Throwaway databases for `*.db.test.ts`. Each call creates a fresh database
// on the server named by DATABASE_URL (the docker-compose one by default),
// runs the migrations in ./drizzle, and drops it again on teardown, so test
// files can run in parallel and never touch the dev database's data.
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import type { Db } from "./client";
import * as schema from "./schema";

const DEFAULT_DATABASE_URL =
  "postgres://fewchat:fewchat@localhost:5432/fewchat";

export type TestDatabase = {
  db: Db;
  /** Opens another connection to the same test database (e.g. a second worker). */
  connect: () => Db;
  teardown: () => Promise<void>;
};

export async function createTestDatabase(): Promise<TestDatabase> {
  const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = `fewchat_test_${randomBytes(6).toString("hex")}`;

  const admin = postgres(baseUrl.toString(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${name}"`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const clients: postgres.Sql[] = [];
  const connect = (): Db => {
    const client = postgres(url.toString(), { onnotice: () => {} });
    clients.push(client);
    return drizzle({ client, schema });
  };

  const db = connect();
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } catch (error) {
    await Promise.all(clients.map((client) => client.end()));
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.end();
    throw error;
  }

  return {
    db,
    connect,
    teardown: async () => {
      await Promise.all(clients.map((client) => client.end()));
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
      await admin.end();
    },
  };
}

// ------------------------------------------------- fixtures (fake data only)

let seq = 0;
const nextId = (prefix: string) =>
  `${prefix}_${++seq}_${randomBytes(3).toString("hex")}`;

export async function insertAccount(db: Db) {
  const [account] = await db
    .insert(schema.instagramAccounts)
    .values({
      instagramUserId: nextId("ig_user_fake"),
      username: "fake_creator",
    })
    .returning();
  return account!;
}

export async function insertAutomation(
  db: Db,
  instagramAccountId: string,
  overrides: Partial<typeof schema.automations.$inferInsert> = {},
) {
  const [automation] = await db
    .insert(schema.automations)
    .values({
      instagramAccountId,
      name: "Fake guide",
      mediaId: nextId("media_fake"),
      triggerType: "keyword",
      keyword: "GUIDE",
      matchMode: "whole_word",
      dmTemplate: "Hey! Here's the resource you asked for: {resource_url}",
      resourceUrl: "https://example.com/guide",
      ...overrides,
    })
    .returning();
  return automation!;
}

export async function insertDelivery(
  db: Db,
  automation: { id: string; instagramAccountId: string },
  overrides: Partial<typeof schema.deliveries.$inferInsert> = {},
) {
  const [delivery] = await db
    .insert(schema.deliveries)
    .values({
      instagramAccountId: automation.instagramAccountId,
      automationId: automation.id,
      commentId: nextId("comment_fake"),
      commenterIgsid: nextId("igsid_fake"),
      source: "webhook",
      status: "QUEUED",
      ...overrides,
    })
    .returning();
  return delivery!;
}
