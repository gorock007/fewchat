// `pnpm seed`: puts a real Instagram account and one automation into a local
// or remote D1 without the dashboard or OAuth, for the Step 3 live Meta test.
// This file exports the CLI; scripts/run-seed.mjs bundles and runs it.
//
// The plaintext token is read from stdin and goes only to Meta and the
// encryption. It is never in argv, a file, stdout or an error message. The SQL
// file handed to wrangler holds ciphertext at most.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/sqlite-proxy";

import { encryptToken } from "../src/crypto/tokens";
import { upsertSeededAccount } from "../src/db/accounts-write";
import type { Db } from "../src/db/deliveries";
import * as schema from "../src/db/schema";
import { automations, MATCH_MODES, type Automation } from "../src/db/schema";
import { validateResourceUrl } from "../src/domain/resource-url";
import { DEFAULT_DM_TEMPLATE, validateTemplate } from "../src/domain/template";
import { createMetaClient } from "../src/meta/client";

const META_BASE_URL = "https://graph.instagram.com";
const DEFAULT_EXPIRES_IN_SECONDS = 60 * 24 * 60 * 60;

export const HELP = `Usage: pnpm seed <account|automation> [options]

Puts your Instagram account and one automation into D1 without the dashboard,
so the Step 3 live Meta test can run.

Step 3 flow:
  1. pnpm seed account                 # token on stdin; see below
  2. pnpm seed automation --media <media id> --keyword guide --url <https url>
  3. comment the keyword on that post from the three test accounts

account
  Reads the long-lived token from stdin (never a flag), asks Meta for the
  account's id and username, subscribes the app to its comment webhooks, and
  stores the token encrypted. Running it again replaces the token.
    printf %s "$TOKEN" | pnpm seed account
    pbpaste | pnpm seed account --remote --config wrangler.deploy.jsonc
  --expires-in <seconds>   token lifetime to record (default 5184000, 60 days)

automation
  --media <id>             the Instagram media id to watch (required)
  --keyword <word>         trigger on this keyword (give it once)
  --any                    trigger on every comment (instead of --keyword)
  --match <mode>           exact | whole_word | contains (default whole_word)
  --url <resource url>     the link sent in the DM (required)
  --message <template>     DM text with {resource_url}, {username}, {keyword}
                           (default: "${DEFAULT_DM_TEMPLATE}")
  --once-per-user          send each commenter at most once (default: off)
  --account <ig user id>   which account; default is the only one in the DB
  --name <text>            label (default "Seed: <keyword or any> on <media id>")
  Any other active automation on the same media is deactivated first.

Both subcommands
  --local                  write to the local D1 (default)
  --remote                 write to the remote D1
  --config <file>          wrangler config, e.g. wrangler.deploy.jsonc

Environment: TOKEN_ENCRYPTION_KEY and META_GRAPH_API_VERSION, from the
environment or .dev.vars. For --remote they must match the deployed Worker's.
`;

/** A failure with a message that is safe to print as is. */
export class CliError extends Error {}

type Target = { remote: boolean; config?: string };

export type SeedCommand =
  | { kind: "help" }
  | { kind: "account"; target: Target; expiresInSeconds: number }
  | {
      kind: "automation";
      target: Target;
      mediaId: string;
      keyword: string | null;
      matchMode: (typeof MATCH_MODES)[number];
      resourceUrl: string;
      dmTemplate: string;
      oncePerUser: boolean;
      account: string | null;
      name: string;
      warnings: string[];
    };

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  local: { type: "boolean" },
  remote: { type: "boolean" },
  config: { type: "string" },
  "expires-in": { type: "string" },
  media: { type: "string" },
  keyword: { type: "string", multiple: true },
  any: { type: "boolean" },
  match: { type: "string" },
  url: { type: "string" },
  message: { type: "string" },
  "once-per-user": { type: "boolean" },
  account: { type: "string" },
  name: { type: "string" },
} as const;

/** Parses and validates argv; throws `CliError` with what to fix. */
export function parseCommand(argv: readonly string[]): SeedCommand {
  const { values, positionals } = (() => {
    try {
      return parseArgs({
        args: [...argv],
        options: OPTIONS,
        allowPositionals: true,
        strict: true,
      });
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : "Invalid arguments",
      );
    }
  })();
  const [subcommand, ...extra] = positionals;
  if (values.help || subcommand === undefined) return { kind: "help" };
  if (extra.length > 0)
    throw new CliError(
      `Unexpected argument: ${extra[0]}. See pnpm seed --help.`,
    );
  if (values.local && values.remote)
    throw new CliError("Use either --local or --remote, not both.");
  const target: Target = {
    remote: values.remote === true,
    ...(values.config === undefined ? {} : { config: values.config }),
  };

  if (subcommand === "account") {
    rejectFlags(values, subcommand, [
      "media",
      "keyword",
      "any",
      "match",
      "url",
      "message",
      "once-per-user",
      "account",
      "name",
    ]);
    let expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS;
    if (values["expires-in"] !== undefined) {
      expiresInSeconds = Number(values["expires-in"]);
      if (!/^\d+$/.test(values["expires-in"]) || !(expiresInSeconds > 0))
        throw new CliError(
          "--expires-in must be a positive whole number of seconds.",
        );
    }
    return { kind: "account", target, expiresInSeconds };
  }
  if (subcommand !== "automation")
    throw new CliError(
      `Unknown subcommand "${subcommand}": use account or automation.`,
    );
  rejectFlags(values, subcommand, ["expires-in"]);

  const mediaId = values.media?.trim();
  if (!mediaId || /\s/.test(mediaId))
    throw new CliError("--media <instagram media id> is required.");
  const keywords = values.keyword ?? [];
  if (keywords.length > 1)
    throw new CliError(
      "--keyword takes one value: an automation has a single keyword. Seed one, or use --any.",
    );
  if (values.any && keywords.length > 0)
    throw new CliError("Use either --keyword or --any, not both.");
  if (!values.any && keywords.length === 0)
    throw new CliError("Give --keyword <word> or --any.");
  const keyword = values.any ? null : keywords[0]!.trim();
  if (keyword === "") throw new CliError("--keyword must not be empty.");
  if (values.any && values.match !== undefined)
    throw new CliError("--match only applies to --keyword.");
  const matchMode = (values.match ??
    "whole_word") as (typeof MATCH_MODES)[number];
  if (!MATCH_MODES.includes(matchMode))
    throw new CliError(`--match must be one of ${MATCH_MODES.join(", ")}.`);

  if (values.url === undefined)
    throw new CliError("--url <resource url> is required.");
  const url = validateResourceUrl(values.url);
  if (!url.ok)
    throw new CliError(`--url is not a valid resource URL (${url.error}).`);
  const warnings = url.warnings.includes("not_https")
    ? ["the resource URL is not https"]
    : [];

  const dmTemplate = values.message ?? DEFAULT_DM_TEMPLATE;
  const template = validateTemplate(dmTemplate, { resourceUrl: url.url });
  if (!template.ok)
    throw new CliError(
      `--message is invalid: ${template.errors.map((e) => e.code).join(", ")}.`,
    );

  const account = values.account?.trim();
  if (values.account !== undefined && !account)
    throw new CliError("--account must not be empty.");
  return {
    kind: "automation",
    target,
    mediaId,
    keyword,
    matchMode,
    resourceUrl: url.url,
    dmTemplate,
    oncePerUser: values["once-per-user"] === true,
    account: account ?? null,
    name: values.name?.trim() || `Seed: ${keyword ?? "any"} on ${mediaId}`,
    warnings,
  };
}

function rejectFlags(
  values: Record<string, unknown>,
  subcommand: string,
  flags: string[],
) {
  const bad = flags.find((flag) => values[flag] !== undefined);
  if (bad) throw new CliError(`--${bad} does not apply to "${subcommand}".`);
}

// ------------------------------------------------------------------- SQL

/** A SQL literal for a bound value. Text never goes through a shell or argv. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Cannot render a non-finite number");
    return String(value);
  }
  if (typeof value === "string") {
    if (value.includes("\u0000"))
      throw new CliError("A value contains a NUL character.");
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new Error("Cannot render this value as SQL");
}

/** Renders a drizzle query with its parameters inlined, for a `--file`. */
export function renderSql(query: {
  toSQL(): { sql: string; params: unknown[] };
}): string {
  const { sql: text, params } = query.toSQL();
  const parts = text.split("?");
  if (parts.length !== params.length + 1)
    throw new Error("Unexpected placeholder count");
  return parts.reduce(
    (out, part, i) =>
      out + part + (i < params.length ? sqlLiteral(params[i]) : ""),
    "",
  );
}

/** A drizzle handle that never runs anything: only builds queries to render. */
function builderDb(): Db {
  return drizzle(async () => ({ rows: [] }), { schema }) as unknown as Db;
}

export function accountSql(
  row: Parameters<typeof upsertSeededAccount>[1],
): string {
  return `${renderSql(upsertSeededAccount(builderDb(), row))};\n`;
}

/** The account the automation belongs to: named by `--account`, else the only one. */
function accountIdSubquery(account: string | null): SQL {
  return account === null
    ? sql`(select id from instagram_accounts where (select count(*) from instagram_accounts) = 1)`
    : sql`(select id from instagram_accounts where instagram_user_id = ${account})`;
}

export function automationSql(
  command: Extract<SeedCommand, { kind: "automation" }>,
  { id, now }: { id: string; now: number },
): string {
  const db = builderDb();
  const accountId = accountIdSubquery(command.account);
  const deactivate = db
    .update(automations)
    .set({ isActive: false, updatedAt: now })
    .where(
      and(
        eq(automations.mediaId, command.mediaId),
        sql`${automations.isActive} = 1`,
        sql`${automations.instagramAccountId} = ${accountId}`,
      ),
    );
  const row: typeof automations.$inferInsert = {
    id,
    instagramAccountId:
      accountId as unknown as Automation["instagramAccountId"],
    name: command.name,
    mediaId: command.mediaId,
    triggerType: command.keyword === null ? "any" : "keyword",
    keyword: command.keyword,
    matchMode: command.keyword === null ? null : command.matchMode,
    dmTemplate: command.dmTemplate,
    resourceUrl: command.resourceUrl,
    publicReplyEnabled: false,
    oncePerUser: command.oncePerUser,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  };
  const insert = db.insert(automations).values(row);
  return `${renderSql(deactivate)};\n${renderSql(insert)};\n`;
}

// -------------------------------------------------------------------- I/O

export type SeedIo = {
  env: Record<string, string | undefined>;
  /** The contents of `.dev.vars`, if there is one. */
  devVars: string | null;
  readStdin(): Promise<string>;
  fetch(request: Request): Promise<Response>;
  now(): number;
  randomId(): string;
  /** The local row id for an Instagram user id, if already seeded. */
  findAccountId(
    target: Target,
    instagramUserId: string,
  ): Promise<string | null>;
  /** Runs SQL against D1. Throws `CliError` when it fails. */
  execute(target: Target, sqlText: string): Promise<void>;
  out(line: string): void;
  err(line: string): void;
};

function parseDevVars(text: string | null): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of (text ?? "").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    vars[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

function seedConfig(io: SeedIo) {
  const vars = parseDevVars(io.devVars);
  const read = (name: string) => io.env[name] || vars[name];
  const encryptionKey = read("TOKEN_ENCRYPTION_KEY");
  const version = read("META_GRAPH_API_VERSION");
  if (!encryptionKey || encryptionKey.length < 32)
    throw new CliError(
      "TOKEN_ENCRYPTION_KEY (at least 32 characters) is not set in the environment or .dev.vars.",
    );
  if (!version || !/^v\d+\.\d+$/.test(version))
    throw new CliError(
      "META_GRAPH_API_VERSION (e.g. v24.0) is not set in the environment or .dev.vars.",
    );
  return { encryptionKey, version };
}

async function seedAccount(
  command: Extract<SeedCommand, { kind: "account" }>,
  io: SeedIo,
) {
  const { encryptionKey, version } = seedConfig(io);
  const token = (await io.readStdin()).trim();
  if (!token)
    throw new CliError(
      "Pipe the long-lived token on stdin, e.g. pbpaste | pnpm seed account.",
    );
  if (/\s/.test(token))
    throw new CliError("The token on stdin contains whitespace.");

  const meta = createMetaClient({
    fetch: io.fetch,
    baseUrl: META_BASE_URL,
    version,
  });
  const account = await meta.getAccount(token);
  if (account.kind !== "ok")
    throw new CliError(
      `Meta rejected the token when reading the account (${account.kind}).`,
    );
  if (!account.data.username)
    throw new CliError("Meta did not return a username for this account.");
  const instagramUserId = account.data.user_id;

  const subscription = await meta.subscribeAccount(instagramUserId, token);
  const subscribed = subscription.kind === "ok";

  const now = io.now();
  // Re-seeding keeps the row id: the token's encryption is bound to it.
  const id =
    (await io.findAccountId(command.target, instagramUserId)) ?? io.randomId();
  const encryptedAccessToken = await encryptToken(token, {
    encryptionKey,
    instagramAccountId: id,
  });
  await io.execute(
    command.target,
    accountSql({
      id,
      instagramUserId,
      username: account.data.username,
      accountType: account.data.account_type ?? null,
      encryptedAccessToken,
      tokenExpiresAt: now + command.expiresInSeconds * 1000,
      webhookSubscriptionStatus: subscribed ? "subscribed" : "failed",
      now,
    }),
  );
  io.out(
    `Seeded @${account.data.username} (instagram user id ${instagramUserId}). Webhook subscription: ${
      subscribed ? "subscribed" : `failed (${subscription.kind})`
    }.`,
  );
}

async function seedAutomation(
  command: Extract<SeedCommand, { kind: "automation" }>,
  io: SeedIo,
) {
  const id = io.randomId();
  try {
    await io.execute(
      command.target,
      automationSql(command, { id, now: io.now() }),
    );
  } catch (error) {
    if (
      error instanceof CliError &&
      error.message.includes("instagram_account_id")
    )
      throw new CliError(
        "No account to attach the automation to: run `pnpm seed account` first, or pass --account <instagram user id> when there is more than one.",
      );
    throw error;
  }
  for (const warning of command.warnings) io.err(`Warning: ${warning}.`);
  io.out(
    `Automation ${id} created and active on media ${command.mediaId}: ${
      command.keyword === null
        ? "any comment"
        : `keyword "${command.keyword}" (${command.matchMode})`
    }; once per user: ${command.oncePerUser ? "yes" : "no"}.`,
  );
}

/** Runs the CLI; returns the exit code. */
export async function runSeed(
  argv: readonly string[],
  io: SeedIo,
): Promise<number> {
  try {
    const command = parseCommand(argv);
    if (command.kind === "help") io.out(HELP);
    else if (command.kind === "account") await seedAccount(command, io);
    else await seedAutomation(command, io);
    return 0;
  } catch (error) {
    // Only our own messages are printed; anything else by its class name.
    io.err(
      error instanceof CliError
        ? `Error: ${error.message}`
        : `Error: unexpected failure (${error instanceof Error ? error.name : "unknown"}).`,
    );
    return 1;
  }
}

// ---------------------------------------------------------------- wrangler

function wranglerArgs(target: Target, rest: string[]): string[] {
  return [
    "exec",
    "wrangler",
    "d1",
    "execute",
    "DB",
    target.remote ? "--remote" : "--local",
    ...(target.config === undefined ? [] : ["--config", target.config]),
    ...rest,
  ];
}

function wrangler(target: Target, rest: string[]) {
  return spawnSync("pnpm", wranglerArgs(target, rest), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const wranglerIo: Pick<SeedIo, "findAccountId" | "execute"> = {
  async findAccountId(target, instagramUserId) {
    const result = wrangler(target, [
      "--json",
      "--command",
      `select id from instagram_accounts where instagram_user_id = ${sqlLiteral(instagramUserId)}`,
    ]);
    if (result.status !== 0)
      throw new CliError(
        `wrangler could not read the database:\n${result.stderr || result.stdout}`,
      );
    // Wrangler may print a banner before the JSON array.
    const start = result.stdout.search(/^\[/m);
    const rows = JSON.parse(result.stdout.slice(Math.max(start, 0))) as {
      results?: { id?: string }[];
    }[];
    return rows[0]?.results?.[0]?.id ?? null;
  },
  async execute(target, sqlText) {
    const dir = mkdtempSync(join(tmpdir(), "fewchat-seed-sql-"));
    try {
      const file = join(dir, "seed.sql");
      writeFileSync(file, sqlText, { mode: 0o600 });
      const result = wrangler(target, ["--file", file]);
      if (result.status !== 0)
        throw new CliError(
          `wrangler d1 execute failed:\n${result.stderr || result.stdout}`,
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
};

async function readProcessStdin(): Promise<string> {
  if (process.stdin.isTTY)
    throw new CliError(
      "Pipe the long-lived token on stdin, e.g. pbpaste | pnpm seed account.",
    );
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

function readDevVars(): string | null {
  try {
    return readFileSync(".dev.vars", "utf8");
  } catch {
    return null;
  }
}

/** The entry point scripts/run-seed.mjs calls. */
export function main(argv: string[]): Promise<number> {
  return runSeed(argv, {
    env: process.env,
    devVars: readDevVars(),
    readStdin: readProcessStdin,
    fetch: (request) => globalThis.fetch(request),
    now: Date.now,
    randomId: () => crypto.randomUUID(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    ...wranglerIo,
  });
}
