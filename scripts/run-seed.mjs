// Launcher for `pnpm seed`: bundles scripts/seed.ts with esbuild (it imports
// src/ modules with extensionless paths, which Node's type stripping cannot
// resolve), runs it, and removes the bundle. No new dependency.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = await mkdtemp(join(tmpdir(), "fewchat-seed-"));
try {
  const outfile = join(dir, "seed.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: ["scripts/seed.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    logLevel: "error",
  });
  const { main } = await import(pathToFileURL(outfile).href);
  process.exitCode = await main(process.argv.slice(2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
