import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasStaticExport, startWorker } from "./harness";

let worker: Awaited<ReturnType<typeof startWorker>>;

beforeAll(async () => {
  if (!hasStaticExport) {
    console.warn(
      "out/ not found: run `pnpm build`. Static asset tests are skipped.",
    );
  }
  worker = await startWorker();
});

afterAll(async () => {
  await worker?.close();
});

describe("fetch", () => {
  it("answers GET /api/health with {ok:true}", async () => {
    const response = await worker.fetch("/api/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns 404 JSON from the Worker for an unknown /api path", async () => {
    const response = await worker.fetch("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it.skipIf(!hasStaticExport)("serves the static export at /", async () => {
    const response = await worker.fetch("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(await response.text()).toMatch(/<html/i);
  });
});

describe("queue", () => {
  it("acks a message for an unknown delivery and a malformed one, with no Meta request", async () => {
    const instance = await worker.getWorker();
    const result = await instance.queue(worker.queueName, [
      {
        id: "fake-message-1",
        timestamp: new Date(),
        body: { deliveryId: "fake-delivery-1" },
        attempts: 1,
      },
      {
        id: "fake-message-2",
        timestamp: new Date(),
        body: { id: "not-a-delivery-message" },
        attempts: 1,
      },
    ]);
    expect(result.outcome).toBe("ok");
    expect(result.explicitAcks).toEqual(["fake-message-1", "fake-message-2"]);
    expect(result.retryMessages).toEqual([]);
    expect(worker.meta.requests).toHaveLength(0);
  });
});

describe("scheduled", () => {
  it("runs the sweep to completion and stamps last_sweep_at", async () => {
    const instance = await worker.getWorker();
    const before = Date.now();
    const result = await instance.scheduled({ cron: "* * * * *" });
    expect(result.outcome).toBe("ok");
    const d1 = await worker.getD1();
    const settings = await d1
      .prepare("SELECT last_sweep_at FROM app_settings WHERE id = 1")
      .first<{ last_sweep_at: number }>();
    expect(settings!.last_sweep_at).toBeGreaterThanOrEqual(before);
  });
});
