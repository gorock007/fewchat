import type { D1Database, ExecutionContext, MessageBatch, Queue, ScheduledController } from "@cloudflare/workers-types";
import { claim, database, finish, markUnknownStale, pending, persist, readDelivery, type EventInput } from "./db";
import { derivePassword, tokenRoundTrip, verifyPassword, verifySignature } from "./crypto";
import { FAKE_HASHES, FAKE_SALT, FAKE_SECRET } from "./fixtures";

export interface Env {
  DB: D1Database;
  DELIVERY_QUEUE?: Queue<{ id: string }>;
  ASSETS: { fetch(request: Request): Promise<Response> };
  // Self service binding used on the deployed spike: a Worker cannot fetch its own workers.dev URL (error 1042).
  MOCK?: { fetch(request: Request): Promise<Response> };
  PROCESSING_MODE: "queue" | "waitUntil";
  SPIKE_ENABLED: "local" | "remote";
  SPIKE_ACCESS_KEY?: string;
  MOCK_URL: string;
}

const response = (body: unknown, status = 200) => Response.json(body, { status });
const loopback = (hostname: string) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);

async function allowed(request: Request, env: Env) {
  if (env.SPIKE_ENABLED === "local") return loopback(new URL(request.url).hostname);
  if (env.SPIKE_ENABLED !== "remote" || !env.SPIKE_ACCESS_KEY) return false;
  const value = request.headers.get("x-spike-access") ?? "";
  // This protects artificial benchmark endpoints, not a production admin session.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SPIKE_ACCESS_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const tag = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(env.SPIKE_ACCESS_KEY));
  return crypto.subtle.verify("HMAC", key, tag, new TextEncoder().encode(value));
}

async function rawBody(request: Request, maxBytes = 32_768): Promise<ArrayBuffer> {
  const reader = request.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new RangeError("body too large"); }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result.buffer;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function normalize(value: unknown): EventInput[] {
  if (!record(value) || value.object !== "instagram" || !Array.isArray(value.entry)) throw new TypeError("invalid envelope");
  const input: EventInput[] = [];
  for (const entry of value.entry) {
    if (!record(entry) || entry.id !== "90000000000000001" || !Array.isArray(entry.changes)) throw new TypeError("fake account required");
    for (const change of entry.changes) {
      if (!record(change) || change.field !== "comments") continue;
      if (!record(change.value) || typeof change.value.id !== "string" || !/^(90000000000000003|fake-[a-zA-Z0-9-]{1,80})$/.test(change.value.id)) throw new TypeError("fake comment required");
      input.push({ id: `${entry.id}:${change.value.id}`, accountId: entry.id, commentId: change.value.id, receivedAt: Date.now() });
      if (input.length > 5) throw new RangeError("max 5 comments per spike request");
    }
  }
  return input;
}

export async function processDelivery(env: Env, id: string) {
  const url = new URL(env.MOCK_URL);
  // Only a loopback mock or this spike's remote mock route can receive a fake send.
  if (env.SPIKE_ENABLED === "local" ? !loopback(url.hostname) :
    !(url.protocol === "https:" && url.hostname.startsWith("fewchat-spike.") && url.hostname.endsWith(".workers.dev") && url.pathname === "/__spike/mock")) {
    throw new TypeError("mock endpoint required");
  }
  const db = database(env.DB);
  const row = await claim(db, id);
  if (!row) return "not-claimed";
  let messageId: string | undefined;
  try {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "x-spike-access": env.SPIKE_ACCESS_KEY ?? "" },
      body: JSON.stringify({ recipient: { comment_id: id }, message: { text: "FAKE_SPIKE_MESSAGE" } }),
      signal: AbortSignal.timeout(5_000),
      redirect: "manual" as const,
    };
    const result = env.MOCK ? await env.MOCK.fetch(new Request(url, init)) : await fetch(url, init);
    const body: unknown = await result.json();
    if (result.ok && record(body) && typeof body.message_id === "string" && body.message_id.startsWith("FAKE_")) messageId = body.message_id;
  } catch (error) { console.error("send outcome uncertain", error instanceof Error ? error.message : "error"); /* Any uncertain HTTP outcome is terminal for automatic resend. */ }
  // A write failure leaves SENDING, so a redelivery still cannot send twice.
  await finish(db, id, messageId);
  return messageId ? "sent" : "unknown";
}

async function enqueue(env: Env, ids: string[]) {
  if (!env.DELIVERY_QUEUE) throw new Error("queue binding missing");
  if (ids.length) await env.DELIVERY_QUEUE.sendBatch(ids.map((id) => ({ body: { id } })));
}

export async function sweep(env: Env) {
  const db = database(env.DB);
  await markUnknownStale(db, Date.now());
  const rows = await pending(db);
  if (env.PROCESSING_MODE === "queue") await enqueue(env, rows.map((row) => row.id));
  else for (const row of rows) await processDelivery(env, row.id);
  return rows.length;
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!["/webhook", "/login"].includes(url.pathname) && !url.pathname.startsWith("/__spike/")) return env.ASSETS.fetch(request);
    if (!await allowed(request, env)) return response({ error: "spike disabled or unauthorized" }, 403);
    try {
      if (url.pathname === "/webhook" && request.method === "POST") {
        const body = await rawBody(request);
        if (!await verifySignature(body, request.headers.get("x-hub-signature-256"), FAKE_SECRET)) return response({ error: "signature" }, 401);
        const input = normalize(JSON.parse(new TextDecoder().decode(body)));
        try { await persist(database(env.DB), input); }
        catch { return response({ error: "persistence failed" }, 503); }
        let dispatched = true;
        if (env.PROCESSING_MODE === "queue") {
          try { await enqueue(env, input.map((row) => row.id)); }
          catch { dispatched = false; /* Durable QUEUED rows remain for cron recovery. */ }
        } else {
          ctx.waitUntil((async () => { for (const row of input) await processDelivery(env, row.id); })());
        }
        return response({ persisted: input.length, dispatched, mode: env.PROCESSING_MODE });
      }
      if (url.pathname === "/login" && request.method === "POST") {
        const body: unknown = JSON.parse(new TextDecoder().decode(await rawBody(request, 1024)));
        if (!record(body) || typeof body.password !== "string") return response({ error: "password required" }, 400);
        const iterations = Number(url.searchParams.get("iterations") ?? 100000);
        const hash = FAKE_HASHES[iterations];
        if (!hash) return response({ error: "unsupported benchmark iteration count" }, 400);
        const verified = await verifyPassword(body.password, hash, FAKE_SALT, iterations);
        if (!verified) return response({ verified: false }, 401);
        return response({ verified, iterations, tokenRoundTrip: await tokenRoundTrip() });
      }
      if (url.pathname === "/__spike/pbkdf2-cap" && request.method === "POST") {
        const iterations = Math.min(Number(url.searchParams.get("iterations") ?? 100001), 1_000_000);
        const repeat = Math.min(Number(url.searchParams.get("repeat") ?? 1), 20);
        try { for (let i = 0; i < repeat; i++) await derivePassword("FAKE_PASSWORD", FAKE_SALT, iterations); return response({ accepted: true, iterations, repeat }); }
        catch (error) { return response({ accepted: false, iterations, reason: error instanceof Error ? error.message : "rejected" }); }
      }
      if (url.pathname === "/__spike/claim" && request.method === "POST") {
        const id = url.searchParams.get("id") ?? "";
        const db = database(env.DB);
        const claims = await Promise.all([claim(db, id), claim(db, id)]);
        return response({ winners: claims.filter(Boolean).length });
      }
      if (url.pathname === "/__spike/delivery" && request.method === "GET") return response(await readDelivery(database(env.DB), url.searchParams.get("id") ?? "") ?? null);
      if (url.pathname === "/__spike/sweep" && request.method === "POST") return response({ found: await sweep(env) });
      if (url.pathname === "/__spike/mock" && request.method === "POST") {
        const body: unknown = JSON.parse(new TextDecoder().decode(await rawBody(request, 1024)));
        if (!record(body) || !record(body.message) || body.message.text !== "FAKE_SPIKE_MESSAGE") return response({ error: "fake message required" }, 400);
        return response({ message_id: "FAKE_MESSAGE_ID_001" });
      }
      return response({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof RangeError) return response({ error: "bounded spike input exceeded" }, 413);
      if (error instanceof SyntaxError || error instanceof TypeError) return response({ error: "invalid spike input" }, 400);
      return response({ error: "spike operation failed" }, 503);
    }
  },
  async queue(batch: MessageBatch<{ id: string }>, env: Env) {
    for (const message of batch.messages) {
      if (!message.body || typeof message.body.id !== "string") { message.ack(); continue; }
      try { await processDelivery(env, message.body.id); message.ack(); }
      catch { message.retry({ delaySeconds: 30 }); }
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) { await sweep(env); },
};

export default worker;
