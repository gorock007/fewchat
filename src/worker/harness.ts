import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { Miniflare } from "miniflare";
import ts from "typescript";

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

/**
 * Bundles the Worker the way wrangler would and runs it in Miniflare with the
 * bindings, assets routing and queue from wrangler.jsonc, on in-memory D1.
 */
export async function startWorker() {
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

  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: config.compatibility_date,
    cf: false,
    d1Databases: Object.fromEntries(
      config.d1_databases.map((d1) => [d1.binding, d1.database_id]),
    ),
    queueProducers: Object.fromEntries(
      config.queues.producers.map((p) => [p.binding, p.queue]),
    ),
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
  });

  return {
    queueName: config.queues.consumers[0]!.queue,
    fetch: (path: string, init?: RequestInit) =>
      mf.dispatchFetch(`http://localhost${path}`, init as never),
    getWorker: () => mf.getWorker(),
    async close() {
      await mf.dispose();
      if (emptyAssets) await rm(emptyAssets, { recursive: true, force: true });
    },
  };
}
