import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import ts from "typescript";

import { FAKE_SIGNING_SECRET } from "../meta/fixtures";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** Whether `pnpm build` has produced the static export the assets tests serve. */
export const hasStaticExport = existsSync(join(root, "out", "index.html"));

type WranglerConfig = {
  compatibility_date: string;
  assets: { directory: string; run_worker_first: string[] };
  d1_databases: { binding: string; database_id: string }[];
  queues: {
    producers: { binding: string; queue: string }[];
    consumers: { queue: string; max_batch_size: number; max_retries: number }[];
  };
};

// Read the real config (comments and trailing commas included) so the harness
// follows it instead of repeating its values.
function readWranglerConfig(): WranglerConfig {
  const text = readFileSync(join(root, "wrangler.jsonc"), "utf8");
  const { config, error } = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    text,
  );
  if (error) throw new Error("Cannot parse wrangler.jsonc");
  return config;
}

/** Fake values for every secret `parseEnv` checks. Never real ones. */
export const FAKE_ENV = {
  APP_URL: "http://localhost:8787",
  META_APP_ID: "FAKE_APP_ID",
  META_APP_SECRET: FAKE_SIGNING_SECRET,
  META_WEBHOOK_VERIFY_TOKEN: "FAKE_VERIFY_TOKEN_NOT_VALID",
  META_GRAPH_API_VERSION: "v24.0",
  TOKEN_ENCRYPTION_KEY: "FAKE_TOKEN_ENCRYPTION_KEY_NOT_VALID_0000",
  ADMIN_PASSWORD_HASH: "FAKE_PASSWORD_HASH",
  SESSION_SECRET: "FAKE_SESSION_SECRET_NOT_VALID_000000000",
} as const;

/**
 * The SQL statements of every migration, in file order, split as drizzle-kit
 * writes them. The same reading as `src/db/test-d1.ts`.
 */
function migrationStatements(): string[] {
  const dir = join(root, "migrations");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) =>
          statement
            .split("\n")
            .some((line) => line.trim() && !line.trim().startsWith("--")),
        ),
    );
}

// Stands in for the DELIVERY_QUEUE producer: hands each call's bodies to the
// harness in Node, and throws when the harness says sends fail.
const QUEUE_SPY = `
export default function (env) {
  async function record(bodies) {
    const response = await env.RECORDER.fetch("http://queue-spy/", {
      method: "POST",
      body: JSON.stringify(bodies),
    });
    if (!response.ok) throw new Error("queue send failed (test)");
  }
  return {
    send: (body) => record([body]),
    sendBatch: (messages) => record(messages.map((message) => message.body)),
  };
}`;

export type StartWorkerOptions = {
  /**
   * Replace the DELIVERY_QUEUE producer with a spy: each `send`/`sendBatch`
   * call lands in `queue.calls` as its list of bodies, or throws while
   * `queue.failSends` is true. The consumer is unchanged.
   */
  spyQueue?: boolean;
};

/**
 * Bundles the Worker the way wrangler would and runs it in Miniflare with the
 * bindings, assets routing and queue from wrangler.jsonc, on in-memory D1 with
 * `migrations/*.sql` applied and fake secrets bound.
 */
export async function startWorker({
  spyQueue = false,
}: StartWorkerOptions = {}) {
  const config = readWranglerConfig();
  const bundle = await build({
    absWorkingDir: root,
    entryPoints: ["src/worker/index.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    write: false,
  });

  // Asset tests are skipped without a build, but Miniflare still needs a directory.
  const emptyAssets = hasStaticExport
    ? undefined
    : await mkdtemp(join(tmpdir(), "fewchat-no-out-"));

  const queue = { calls: [] as unknown[][], failSends: false };
  const producers = config.queues.producers.filter(
    (p) => !(spyQueue && p.binding === "DELIVERY_QUEUE"),
  );

  const worker = {
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: config.compatibility_date,
    bindings: { ...FAKE_ENV },
    d1Databases: Object.fromEntries(
      config.d1_databases.map((d1) => [d1.binding, d1.database_id]),
    ),
    queueProducers: Object.fromEntries(
      producers.map((p) => [p.binding, p.queue]),
    ),
    wrappedBindings: spyQueue ? { DELIVERY_QUEUE: "queue-spy" } : undefined,
    queueConsumers: Object.fromEntries(
      config.queues.consumers.map((c) => [
        c.queue,
        { maxBatchSize: c.max_batch_size, maxRetries: c.max_retries },
      ]),
    ),
    assets: {
      directory: emptyAssets ?? join(root, "out"),
      // Miniflare takes the router config wrangler derives from `run_worker_first`.
      routerConfig: {
        has_user_worker: true,
        static_routing: { user_worker: config.assets.run_worker_first },
      },
    },
  };
  const spy = {
    name: "queue-spy",
    modules: true,
    script: QUEUE_SPY,
    serviceBindings: {
      async RECORDER(request: Request) {
        if (queue.failSends) return new Response(null, { status: 500 });
        queue.calls.push((await request.json()) as unknown[]);
        return new Response(null, { status: 204 });
      },
    },
  };

  const mf = new Miniflare({
    cf: false,
    workers: spyQueue ? [worker, spy] : [worker],
  });
  try {
    const d1 = await mf.getD1Database("DB");
    for (const statement of migrationStatements()) {
      await d1.prepare(statement).run();
    }
  } catch (error) {
    await mf.dispose();
    if (emptyAssets) await rm(emptyAssets, { recursive: true, force: true });
    throw error;
  }

  return {
    queueName: config.queues.consumers[0]!.queue,
    /** What DELIVERY_QUEUE was sent, with `spyQueue` only. */
    queue,
    getD1: () => mf.getD1Database("DB"),
    fetch: (path: string, init?: RequestInit) =>
      mf.dispatchFetch(`http://localhost${path}`, init as never),
    getWorker: () => mf.getWorker(),
    async close() {
      await mf.dispose();
      if (emptyAssets) await rm(emptyAssets, { recursive: true, force: true });
    },
  };
}
