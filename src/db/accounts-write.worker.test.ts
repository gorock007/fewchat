// Account writes, and the `pnpm seed` CLI end to end against a test D1. The CLI
// lives in scripts/ but its tests live here because the Vitest projects only
// include src/. The wrangler call is replaced by applying the CLI's SQL
// straight to the test database.
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CliError,
  HELP,
  parseCommand,
  runSeed,
  sqlLiteral,
  type SeedIo,
} from "../../scripts/seed";
import { decryptToken } from "../crypto/tokens";
import { DEFAULT_DM_TEMPLATE } from "../domain/template";
import { saveRefreshedToken, stampTokenRefreshAttempt } from "./accounts-write";
import { automations, instagramAccounts } from "./schema";
import { insertAccount, startTestD1, type TestD1 } from "./test-d1";

const KEY = "FAKE_SEED_TEST_ENCRYPTION_KEY_000000";
const TOKEN = "FAKE_SEED_LONG_LIVED_TOKEN_NOT_REAL";
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** Splits SQL on `;` outside single-quoted strings. */
function statements(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of text) {
    if (char === "'") quoted = !quoted;
    if (char === ";" && !quoted) {
      out.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

describe("account refresh writes", () => {
  let t: TestD1;
  beforeAll(async () => {
    t = await startTestD1();
  });
  afterAll(async () => {
    await t?.dispose();
  });

  it("stamp and save apply only to the ciphertext that was read", async () => {
    const account = await insertAccount(t.db, {
      encryptedAccessToken: "v1.old.old",
    });
    expect(
      await stampTokenRefreshAttempt(t.db, account.id, NOW, "v1.other.x"),
    ).toBe(false);
    expect(
      await stampTokenRefreshAttempt(t.db, account.id, NOW, "v1.old.old"),
    ).toBe(true);
    const save = (previous: string) =>
      saveRefreshedToken(t.db, {
        accountId: account.id,
        now: NOW,
        previousEncryptedAccessToken: previous,
        encryptedAccessToken: "v1.new.new",
        tokenExpiresAt: NOW + 60 * DAY,
      });
    expect(await save("v1.other.x")).toBe(false);
    expect(await save("v1.old.old")).toBe(true);
    const [row] = await t.db
      .select()
      .from(instagramAccounts)
      .where(eq(instagramAccounts.id, account.id));
    expect(row).toMatchObject({
      encryptedAccessToken: "v1.new.new",
      tokenExpiresAt: NOW + 60 * DAY,
      tokenRefreshedAt: NOW,
      tokenRefreshAttemptedAt: NOW,
    });
  });
});

describe("seed CLI arguments", () => {
  const automation = [
    "automation",
    "--media",
    "media_fake_1",
    "--url",
    "https://example.com/guide",
  ];

  it("prints the Step 3 flow for --help, -h and no arguments", () => {
    for (const argv of [["--help"], ["-h"], [], ["account", "--help"]]) {
      expect(parseCommand(argv)).toEqual({ kind: "help" });
    }
    expect(HELP).toMatch(/seed account/);
    expect(HELP).toMatch(/seed automation/);
    expect(HELP).toMatch(/three test accounts/);
    expect(HELP).toMatch(/--remote/);
    expect(HELP).toMatch(/--config/);
  });

  it("parses an account command; local is the default", () => {
    expect(parseCommand(["account"])).toEqual({
      kind: "account",
      target: { remote: false },
      expiresInSeconds: 60 * 24 * 60 * 60,
    });
    expect(
      parseCommand([
        "account",
        "--remote",
        "--config",
        "wrangler.deploy.jsonc",
        "--expires-in",
        "3600",
      ]),
    ).toEqual({
      kind: "account",
      target: { remote: true, config: "wrangler.deploy.jsonc" },
      expiresInSeconds: 3600,
    });
  });

  it("has no flag that could carry the token", () => {
    for (const flag of ["--token", "--access-token"]) {
      expect(() => parseCommand(["account", flag, TOKEN])).toThrow(CliError);
    }
  });

  it("parses an automation with its defaults", () => {
    expect(
      parseCommand([...automation, "--keyword", "  guide "]),
    ).toMatchObject({
      kind: "automation",
      mediaId: "media_fake_1",
      keyword: "guide",
      matchMode: "whole_word",
      resourceUrl: "https://example.com/guide",
      dmTemplate: DEFAULT_DM_TEMPLATE,
      oncePerUser: false,
      account: null,
      name: "Seed: guide on media_fake_1",
    });
    expect(
      parseCommand([...automation, "--any", "--once-per-user"]),
    ).toMatchObject({
      keyword: null,
      oncePerUser: true,
      name: "Seed: any on media_fake_1",
    });
  });

  it.each([
    [
      "a repeated --keyword",
      [...["--keyword", "a", "--keyword", "b"]],
      /--keyword takes one value/,
    ],
    [
      "--keyword with --any",
      ["--keyword", "a", "--any"],
      /either --keyword or --any/,
    ],
    ["neither --keyword nor --any", [], /--keyword <word> or --any/],
    ["an empty --keyword", ["--keyword", "  "], /must not be empty/],
    [
      "--match with --any",
      ["--any", "--match", "exact"],
      /only applies to --keyword/,
    ],
    [
      "a bad --match",
      ["--keyword", "a", "--match", "fuzzy"],
      /--match must be one of/,
    ],
    [
      "a bad template",
      ["--any", "--message", "no link here"],
      /missing_resource_url/,
    ],
    [
      "a bad placeholder",
      ["--any", "--message", "{resource_url} {nope}"],
      /unknown_placeholder/,
    ],
    [
      "--expires-in on automation",
      ["--any", "--expires-in", "5"],
      /does not apply/,
    ],
    ["--local with --remote", ["--any", "--local", "--remote"], /not both/],
    ["an unknown flag", ["--any", "--wat"], /Unknown option/],
  ])("rejects %s", (_, extra, message) => {
    expect(() => parseCommand([...automation, ...extra])).toThrow(message);
  });

  it("rejects a missing or bad media, url, subcommand and expires-in", () => {
    expect(() =>
      parseCommand(["automation", "--any", "--url", "https://e.co"]),
    ).toThrow(/--media/);
    expect(() => parseCommand(["automation", "--any", "--media", "m"])).toThrow(
      /--url/,
    );
    expect(() =>
      parseCommand([
        "automation",
        "--any",
        "--media",
        "m",
        "--url",
        "ftp://e.co",
      ]),
    ).toThrow(/unsupported_protocol/);
    expect(() => parseCommand(["wat"])).toThrow(/Unknown subcommand/);
    expect(() => parseCommand(["account", "--expires-in", "-5"])).toThrow(
      /--expires-in/,
    );
    expect(() => parseCommand(["account", "--media", "m"])).toThrow(
      /does not apply/,
    );
  });

  it("quotes SQL text safely", () => {
    expect(sqlLiteral("it's; -- \n x")).toBe("'it''s; -- \n x'");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("1");
    expect(() => sqlLiteral("a\u0000b")).toThrow(CliError);
  });
});

describe("seed CLI against a test database", () => {
  let t: TestD1;
  let ids = 0;
  beforeAll(async () => {
    t = await startTestD1();
  });
  afterAll(async () => {
    await t?.dispose();
  });
  afterEach(async () => {
    ids = 0;
    await t.db.delete(automations);
    await t.db.delete(instagramAccounts);
  });

  type Fake = {
    io: SeedIo;
    out: string[];
    err: string[];
    sql: string[];
    requests: { url: string; authorization: string | null }[];
    meta: { subscribe: "ok" | "fail"; account: "ok" | "invalid" };
  };

  function fake(
    stdin: string = `${TOKEN}\n`,
    env: Record<string, string | undefined> = {
      TOKEN_ENCRYPTION_KEY: KEY,
      META_GRAPH_API_VERSION: "v24.0",
    },
    devVars: string | null = null,
  ): Fake {
    const f: Fake = {
      out: [],
      err: [],
      sql: [],
      requests: [],
      meta: { subscribe: "ok", account: "ok" },
      io: undefined as never,
    };
    f.io = {
      env,
      devVars,
      readStdin: async () => stdin,
      fetch: async (request) => {
        const url = new URL(request.url);
        f.requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        if (url.pathname.endsWith("/me"))
          return f.meta.account === "invalid"
            ? Response.json(
                { error: { code: 190, message: "Synthetic invalid token" } },
                { status: 400 },
              )
            : Response.json({
                user_id: "ig_user_seed_fake",
                username: "seed_fake_creator",
                account_type: "BUSINESS",
              });
        if (url.pathname.endsWith("/subscribed_apps"))
          return f.meta.subscribe === "ok"
            ? Response.json({ success: true })
            : Response.json(
                { error: { code: 10, message: "Synthetic denial" } },
                { status: 403 },
              );
        return new Response("{}", { status: 404 });
      },
      now: () => NOW,
      randomId: () => `generated-id-${++ids}`,
      findAccountId: async (_target, instagramUserId) => {
        const [row] = await t.db
          .select({ id: instagramAccounts.id })
          .from(instagramAccounts)
          .where(eq(instagramAccounts.instagramUserId, instagramUserId));
        return row?.id ?? null;
      },
      execute: async (_target, sqlText) => {
        f.sql.push(sqlText);
        try {
          for (const statement of statements(sqlText))
            await t.d1.prepare(statement).run();
        } catch (error) {
          // Wrangler prints the database error; so does this stand-in.
          throw new CliError(
            `wrangler d1 execute failed: ${error instanceof Error ? error.message : ""}`,
          );
        }
      },
      out: (line) => f.out.push(line),
      err: (line) => f.err.push(line),
    };
    return f;
  }

  const everything = (f: Fake) => [...f.out, ...f.err, ...f.sql].join("\n");

  async function accounts() {
    return t.db.select().from(instagramAccounts);
  }

  it("seeds an account: encrypted, subscribed, connected, token never leaked", async () => {
    const f = fake();
    expect(await runSeed(["account"], f.io)).toBe(0);

    const [row] = await accounts();
    expect(row).toMatchObject({
      id: "generated-id-1",
      instagramUserId: "ig_user_seed_fake",
      username: "seed_fake_creator",
      accountType: "BUSINESS",
      connectionStatus: "connected",
      webhookSubscriptionStatus: "subscribed",
      tokenExpiresAt: NOW + 60 * DAY,
      tokenRefreshedAt: NOW,
      lastConnectedAt: NOW,
      tokenRefreshAttemptedAt: null,
    });
    await expect(
      decryptToken(row!.encryptedAccessToken!, {
        encryptionKey: KEY,
        instagramAccountId: row!.id,
      }),
    ).resolves.toBe(TOKEN);

    expect(f.out).toEqual([
      "Seeded @seed_fake_creator (instagram user id ig_user_seed_fake). Webhook subscription: subscribed.",
    ]);
    expect(f.err).toEqual([]);
    // The plaintext goes to Meta (a bearer header, and the query string on the
    // subscribe call, which is how the Meta client sends it) and nowhere we write.
    expect(f.requests[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(f.requests[1]!.url).toContain(`access_token=${TOKEN}`);
    expect(f.requests[0]!.url).toContain("/v24.0/me");
    expect(f.requests[1]!.url).toContain(
      "/v24.0/ig_user_seed_fake/subscribed_apps",
    );
  });

  it("reads the key and version from .dev.vars when the environment lacks them", async () => {
    const f = fake(
      `${TOKEN}\n`,
      {},
      `# comment\nTOKEN_ENCRYPTION_KEY="${KEY}"\nMETA_GRAPH_API_VERSION=v24.0\n`,
    );
    expect(await runSeed(["account"], f.io)).toBe(0);
    expect(await accounts()).toHaveLength(1);
  });

  it("records a failed subscription and still seeds", async () => {
    const f = fake();
    f.meta.subscribe = "fail";
    expect(await runSeed(["account", "--expires-in", "3600"], f.io)).toBe(0);

    const [row] = await accounts();
    expect(row).toMatchObject({
      webhookSubscriptionStatus: "failed",
      tokenExpiresAt: NOW + 3600 * 1000,
    });
    expect(f.out[0]).toMatch(
      /Webhook subscription: failed \(permission_denied\)/,
    );
    expect(everything(f)).not.toContain(TOKEN);
  });

  it("re-seeding keeps the row id, replaces the token and reconnects", async () => {
    await runSeed(["account"], fake().io);
    const [first] = await accounts();
    await t.db
      .update(instagramAccounts)
      .set({
        connectionStatus: "needs_reconnect",
        tokenRefreshAttemptedAt: NOW - 1,
        tokenRefreshedAt: NOW - 50 * DAY,
      })
      .where(eq(instagramAccounts.id, first!.id));

    const second = fake("FAKE_SECOND_TOKEN\n");
    expect(await runSeed(["account"], second.io)).toBe(0);

    const rows = await accounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first!.id,
      connectionStatus: "connected",
      tokenRefreshedAt: NOW,
      tokenRefreshAttemptedAt: null,
    });
    expect(rows[0]!.encryptedAccessToken).not.toBe(first!.encryptedAccessToken);
    await expect(
      decryptToken(rows[0]!.encryptedAccessToken!, {
        encryptionKey: KEY,
        instagramAccountId: first!.id,
      }),
    ).resolves.toBe("FAKE_SECOND_TOKEN");
    expect(everything(second)).not.toContain("FAKE_SECOND_TOKEN");
  });

  it("writes nothing when Meta rejects the token, and says so without it", async () => {
    const f = fake();
    f.meta.account = "invalid";
    expect(await runSeed(["account"], f.io)).toBe(1);
    expect(await accounts()).toHaveLength(0);
    expect(f.sql).toEqual([]);
    expect(f.err.join("\n")).toMatch(/token_invalid/);
    expect(everything(f)).not.toContain(TOKEN);
  });

  it.each([
    [
      "empty stdin",
      "  \n",
      { TOKEN_ENCRYPTION_KEY: KEY, META_GRAPH_API_VERSION: "v24.0" },
      /Pipe the long-lived token/,
    ],
    [
      "a token with whitespace",
      "two words",
      { TOKEN_ENCRYPTION_KEY: KEY, META_GRAPH_API_VERSION: "v24.0" },
      /whitespace/,
    ],
    [
      "a short key",
      `${TOKEN}\n`,
      { TOKEN_ENCRYPTION_KEY: "short", META_GRAPH_API_VERSION: "v24.0" },
      /TOKEN_ENCRYPTION_KEY/,
    ],
    [
      "no Graph version",
      `${TOKEN}\n`,
      { TOKEN_ENCRYPTION_KEY: KEY },
      /META_GRAPH_API_VERSION/,
    ],
  ])(
    "fails clearly on %s, without echoing the token",
    async (_, stdin, env, message) => {
      const f = fake(stdin, env);
      expect(await runSeed(["account"], f.io)).toBe(1);
      expect(f.err.join("\n")).toMatch(message);
      expect(f.requests).toEqual([]);
      expect(everything(f)).not.toContain(TOKEN);
      expect(everything(f)).not.toContain("two words");
    },
  );

  it("an unexpected error prints only its class", async () => {
    const f = fake();
    // The Meta client turns transport errors into outcomes, so fail the write.
    f.io.execute = async () => {
      throw new RangeError(`boom ${TOKEN}`);
    };
    expect(await runSeed(["account"], f.io)).toBe(1);
    expect(f.err).toEqual(["Error: unexpected failure (RangeError)."]);
  });

  describe("automation", () => {
    const seedAccount = () => runSeed(["account"], fake().io);
    const args = [
      "automation",
      "--media",
      "media_fake_1",
      "--url",
      "https://example.com/guide",
    ];

    it("creates an active keyword automation on the only account", async () => {
      await seedAccount();
      const f = fake();
      expect(
        await runSeed(
          [
            ...args,
            "--keyword",
            "guide",
            "--match",
            "contains",
            "--once-per-user",
            "--message",
            "Hi {username}; it's here: {resource_url}",
          ],
          f.io,
        ),
      ).toBe(0);

      const [account] = await accounts();
      const [row] = await t.db.select().from(automations);
      expect(row).toMatchObject({
        id: "generated-id-2",
        instagramAccountId: account!.id,
        name: "Seed: guide on media_fake_1",
        mediaId: "media_fake_1",
        triggerType: "keyword",
        keyword: "guide",
        matchMode: "contains",
        dmTemplate: "Hi {username}; it's here: {resource_url}",
        resourceUrl: "https://example.com/guide",
        oncePerUser: true,
        publicReplyEnabled: false,
        isActive: true,
        deletedAt: null,
      });
      expect(f.out).toEqual([
        'Automation generated-id-2 created and active on media media_fake_1: keyword "guide" (contains); once per user: yes.',
      ]);
    });

    it("creates an any-comment automation with the default template and once-per-user off", async () => {
      await seedAccount();
      const f = fake();
      expect(
        await runSeed([...args, "--any", "--name", "Live test"], f.io),
      ).toBe(0);
      const [row] = await t.db.select().from(automations);
      expect(row).toMatchObject({
        name: "Live test",
        triggerType: "any",
        keyword: null,
        matchMode: null,
        dmTemplate: DEFAULT_DM_TEMPLATE,
        oncePerUser: false,
      });
      expect(f.out[0]).toMatch(/any comment; once per user: no\./);
    });

    it("deactivates the other active automation on the same media first", async () => {
      await seedAccount();
      await runSeed([...args, "--keyword", "one"], fake().io);
      await runSeed(
        [
          "automation",
          "--media",
          "media_fake_2",
          "--url",
          "https://example.com/other",
          "--any",
        ],
        fake().io,
      );
      const two = fake();
      expect(
        await runSeed([...args, "--keyword", "two"], two.io),
        two.err.join(),
      ).toBe(0);

      const rows = await t.db.select().from(automations);
      const byKeyword = (k: string | null) =>
        rows.find((r) => r.keyword === k)!;
      expect(byKeyword("one").isActive).toBe(false);
      expect(byKeyword("two").isActive).toBe(true);
      // Another media's automation is untouched.
      expect(rows.find((r) => r.mediaId === "media_fake_2")!.isActive).toBe(
        true,
      );
    });

    it("without an account, fails with the hint and writes nothing", async () => {
      const f = fake();
      expect(await runSeed([...args, "--any"], f.io)).toBe(1);
      expect(f.err.join("\n")).toMatch(
        /run `pnpm seed account` first, or pass --account/,
      );
      expect(await t.db.select().from(automations)).toHaveLength(0);
    });

    it("with several accounts needs --account", async () => {
      await seedAccount();
      await insertAccount(t.db, { instagramUserId: "ig_user_other_fake" });

      const f = fake();
      expect(await runSeed([...args, "--any"], f.io)).toBe(1);
      expect(f.err.join("\n")).toMatch(/pass --account/);
      expect(await t.db.select().from(automations)).toHaveLength(0);

      const g = fake();
      expect(
        await runSeed(
          [...args, "--any", "--account", "ig_user_other_fake"],
          g.io,
        ),
      ).toBe(0);
      const [row] = await t.db.select().from(automations);
      const [other] = await t.db
        .select()
        .from(instagramAccounts)
        .where(eq(instagramAccounts.instagramUserId, "ig_user_other_fake"));
      expect(row!.instagramAccountId).toBe(other!.id);
    });

    it("warns, but still seeds, for a non-https resource URL", async () => {
      await seedAccount();
      const f = fake();
      expect(
        await runSeed(
          [
            "automation",
            "--media",
            "m1",
            "--any",
            "--url",
            "http://example.com/x",
          ],
          f.io,
        ),
      ).toBe(0);
      expect(f.err).toEqual(["Warning: the resource URL is not https."]);
    });

    it("never touches Meta or the token", async () => {
      await seedAccount();
      const f = fake();
      await runSeed([...args, "--any"], f.io);
      expect(f.requests).toEqual([]);
      expect(everything(f)).not.toContain(TOKEN);
    });
  });
});
