import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/d1";
import { Miniflare } from "miniflare";

import type { Db } from "./deliveries";
import * as schema from "./schema";

const root = fileURLToPath(new URL("../..", import.meta.url));
const migrationsDir = join(root, "migrations");

// Follow wrangler.jsonc rather than repeat it.
const compatibilityDate = /"compatibility_date":\s*"([^"]+)"/.exec(
  readFileSync(join(root, "wrangler.jsonc"), "utf8"),
)![1]!;

/** The SQL statements of every migration, in file order, as drizzle-kit splits them. */
function migrationStatements(): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(migrationsDir, name), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        // A chunk of nothing but comments is not a statement.
        .filter((statement) =>
          statement
            .split("\n")
            .some((line) => line.trim() && !line.trim().startsWith("--")),
        ),
    );
}

/**
 * Starts Miniflare (real workerd) with one in-memory D1 database and applies
 * `migrations/*.sql` in order. Local D1 is not production D1 (ADR 0002 gate 8).
 */
export async function startTestD1() {
  const mf = new Miniflare({
    modules: true,
    script:
      "export default { fetch: () => new Response(null, { status: 404 }) }",
    compatibilityDate,
    cf: false,
    d1Databases: { DB: "test-db" },
  });
  try {
    const d1 = await mf.getD1Database("DB");
    for (const statement of migrationStatements()) {
      await d1.prepare(statement).run();
    }
    // The same drizzle setup as `getDb` (./client imports the Workers globals).
    const db: Db = drizzle(d1 as never, { schema });
    return { d1, db, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export type TestD1 = Awaited<ReturnType<typeof startTestD1>>;

// ---------------------------------------------------------------- fixtures
// Obviously fake IDs and names only (this repo is public).

let sequence = 0;
/** A unique fake ID with a readable prefix. */
export const fakeId = (prefix: string) => `${prefix}_fake_${++sequence}`;

export async function insertAccount(
  db: Db,
  overrides: Partial<schema.NewInstagramAccount> = {},
) {
  const [account] = await db
    .insert(schema.instagramAccounts)
    .values({
      instagramUserId: fakeId("ig_user"),
      username: fakeId("creator"),
      ...overrides,
    })
    .returning();
  return account!;
}

export async function insertAutomation(
  db: Db,
  instagramAccountId: string,
  overrides: Partial<schema.NewAutomation> = {},
) {
  const [automation] = await db
    .insert(schema.automations)
    .values({
      instagramAccountId,
      name: "Fake automation",
      mediaId: fakeId("media"),
      triggerType: "keyword",
      keyword: "guide",
      matchMode: "whole_word",
      dmTemplate: "Here it is: {link}",
      resourceUrl: "https://example.com/fake-guide",
      ...overrides,
    })
    .returning();
  return automation!;
}

/** Drizzle wraps the D1 error; returns every message in the cause chain. */
export async function failureOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) throw new Error("expected the query to fail");
  const messages: string[] = [];
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    messages.push(e.message);
  }
  return messages.join(" <- ");
}
