import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHmac } from "node:crypto";

export async function importSource(file) {
  const result = await build({ entryPoints: [file], bundle: true, format: "esm", platform: "node", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}
export const fixtures = await importSource("src/fixtures.ts");
export function signedBody(commentId = "90000000000000003") {
  const value = structuredClone(fixtures.payload);
  value.entry[0].changes[0].value.id = commentId;
  const body = JSON.stringify(value);
  return { body, signature: `sha256=${createHmac("sha256", fixtures.FAKE_SECRET).update(body).digest("hex")}` };
}
export async function startMock(port = 0) {
  const state = { sends: 0, mode: "ok" };
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.url !== "/messages" || request.method !== "POST" || !body.includes("FAKE_SPIKE_MESSAGE")) {
      response.writeHead(400).end(); return;
    }
    state.sends++;
    if (state.mode === "disconnect") { request.socket.destroy(); return; }
    response.writeHead(state.mode === "error" ? 503 : 200, { "content-type": "application/json" });
    response.end(state.mode === "malformed" ? "{}" : JSON.stringify({ message_id: "FAKE_MESSAGE_ID_001" }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    state, url: `http://127.0.0.1:${server.address().port}/messages`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections();
    }),
  };
}

export async function harness({ mode = "queue", queue = true } = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "fewchat-cf-spike-"));
  const mock = await startMock();
  let mf;
  try {
    const result = await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", platform: "browser", write: false });
    mf = new Miniflare({
      rootPath: scratch, modules: true, script: result.outputFiles[0].text,
      compatibilityDate: "2026-07-30", cf: false,
      d1Databases: { DB: "fake-spike-db" },
      bindings: { PROCESSING_MODE: mode, SPIKE_ENABLED: "local", MOCK_URL: mock.url },
      ...(queue ? {
        queueProducers: { DELIVERY_QUEUE: "fewchat-spike-q" },
        queueConsumers: { "fewchat-spike-q": { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } },
      } : {}),
      // Miniflare takes the router config wrangler derives from `run_worker_first`.
      assets: {
        directory: resolve("../out"), binding: "ASSETS",
        routerConfig: { has_user_worker: true, static_routing: { user_worker: ["/webhook", "/login", "/__spike/*"] } },
      },
    });
    const { DB: db } = await mf.getBindings();
    const migration = await readFile("migrations/0001_spike.sql", "utf8");
    await db.batch(migration.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s)));
    return { mf, db, mock,
      fetch: (path, init) => mf.dispatchFetch(`http://localhost${path}`, init),
      postWebhook: (id) => {
        const { body, signature } = signedBody(id);
        return mf.dispatchFetch("http://localhost/webhook", { method: "POST", headers: { "x-hub-signature-256": signature }, body });
      },
      async close() { await mf.dispose(); await mock.close(); await rm(scratch, { recursive: true, force: true }); },
    };
  } catch (error) {
    if (mf) await mf.dispose();
    await mock.close(); await rm(scratch, { recursive: true, force: true }); throw error;
  }
}

export async function until(check) {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const result = await check(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for local result");
}
