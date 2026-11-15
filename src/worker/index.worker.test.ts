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
  it("acks a delivery message", async () => {
    const instance = await worker.getWorker();
    const result = await instance.queue(worker.queueName, [
      {
        id: "fake-message-1",
        timestamp: new Date(),
        body: { id: "fake-delivery-1" },
        attempts: 1,
      },
    ]);
    expect(result.outcome).toBe("ok");
    expect(result.explicitAcks).toEqual(["fake-message-1"]);
    expect(result.retryMessages).toEqual([]);
  });
});

describe("scheduled", () => {
  it("runs the cron handler to completion", async () => {
    const instance = await worker.getWorker();
    const result = await instance.scheduled({ cron: "* * * * *" });
    expect(result.outcome).toBe("ok");
  });
});
