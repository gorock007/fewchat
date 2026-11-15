import test from "node:test";
import assert from "node:assert/strict";
import { harness, signedBody, fixtures, until } from "../scripts/harness.mjs";
const id = "90000000000000001:90000000000000003";
const delivery = (h, key = id) => h.db.prepare("SELECT * FROM deliveries WHERE id = ?").bind(key).first();

test("static export serves the existing home page and CSS", async (t) => {
  const h = await harness(); t.after(() => h.close());
  const result = await h.fetch("/");
  assert.equal(result.status, 200);
  const html = await result.text();
  assert.match(html, /FewChat/);
  const css = html.match(/href="([^"]+\.css)"/)[1];
  assert.equal((await h.fetch(css)).status, 200);
});

test("raw-byte HMAC rejects missing, malformed, altered and oversized bodies before persistence", async (t) => {
  const h = await harness(); t.after(() => h.close());
  const { body, signature } = signedBody();
  for (const [value, digest] of [[body, ""], [body, "sha256=bad"], [body + " ", signature]]) {
    assert.equal((await h.fetch("/webhook", { method: "POST", body: value, headers: { "x-hub-signature-256": digest } })).status, 401);
  }
  assert.equal((await h.fetch("/webhook", { method: "POST", body: "x".repeat(32769) })).status, 413);
  assert.equal((await h.db.prepare("SELECT count(*) AS n FROM events").first()).n, 0);
});

test("Drizzle D1 batch rolls back the event if delivery persistence fails, returning 503", async (t) => {
  const h = await harness(); t.after(() => h.close());
  await h.db.prepare("CREATE TRIGGER fail_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END").run();
  assert.equal((await h.postWebhook()).status, 503);
  assert.equal((await h.db.prepare("SELECT count(*) AS n FROM events").first()).n, 0);
  assert.equal(h.mock.state.sends, 0);
});

for (const mode of ["queue", "waitUntil"]) {
  test(`${mode}: duplicates persist once and send once, including concurrent ingress`, async (t) => {
    const h = await harness({ mode }); t.after(() => h.close());
    const responses = await Promise.all([h.postWebhook(), h.postWebhook()]);
    for (const result of responses) assert.equal(result.status, 200);
    await until(async () => (await delivery(h))?.status === "SENT");
    assert.equal((await h.db.prepare("SELECT count(*) AS n FROM events").first()).n, 1);
    const worker = await h.mf.getWorker();
    await worker.queue("fewchat-spike-q", [{ id: "fake-redelivery", timestamp: new Date(), body: { id }, attempts: 2 }]);
    assert.equal(h.mock.state.sends, 1);
    assert.equal((await delivery(h)).attempts, 1);
  });
}

test("queue dispatch failure preserves acknowledged intent; two concurrent D1 claims have one winner", async (t) => {
  const h = await harness({ queue: false }); t.after(() => h.close());
  const result = await h.postWebhook();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).dispatched, false);
  assert.equal((await delivery(h)).status, "QUEUED");
  const claim = await h.fetch(`/__spike/claim?id=${encodeURIComponent(id)}`, { method: "POST" });
  assert.equal((await claim.json()).winners, 1);
  assert.equal((await delivery(h)).attempts, 1);
});

for (const mode of ["queue", "waitUntil"]) {
  test(`${mode}: scheduled sweep rediscovers unscheduled QUEUED rows and quarantines stale SENDING`, async (t) => {
    const h = await harness({ mode }); t.after(() => h.close());
    for (const [key, status] of [["fake-cron", "QUEUED"], ["fake-stale", "SENDING"], ["fake-unknown", "DELIVERY_UNKNOWN"]]) {
      await h.db.prepare("INSERT INTO events VALUES (?, 'fake-account', ?, 0)").bind(key, key).run();
      await h.db.prepare("INSERT INTO deliveries (id, status, created_at, claimed_at) VALUES (?, ?, 0, 0)").bind(key, status).run();
    }
    const worker = await h.mf.getWorker();
    assert.equal((await worker.scheduled({ cron: "* * * * *" })).outcome, "ok");
    await until(async () => (await delivery(h, "fake-cron"))?.status === "SENT");
    assert.equal((await delivery(h, "fake-stale")).status, "DELIVERY_UNKNOWN");
    assert.equal((await delivery(h, "fake-unknown")).attempts, 0);
    assert.equal(h.mock.state.sends, 1);
  });
}

for (const failure of ["malformed", "disconnect", "error"]) {
  test(`uncertain ${failure} response is never retried by queue or cron`, async (t) => {
    const h = await harness({ mode: "waitUntil" }); t.after(() => h.close());
    h.mock.state.mode = failure;
    await h.postWebhook();
    await until(async () => (await delivery(h))?.status === "DELIVERY_UNKNOWN");
    const worker = await h.mf.getWorker();
    await worker.queue("fewchat-spike-q", [{ id: "fake-repeat", timestamp: new Date(), body: { id }, attempts: 2 }]);
    await worker.scheduled({ cron: "* * * * *" });
    assert.equal(h.mock.state.sends, 1);
  });
}

test("PBKDF2 verifies all benchmark work factors; AES-GCM round-trip and runtime cap", async (t) => {
  const h = await harness(); t.after(() => h.close());
  for (const iterations of [10000, 25000, 50000, 100000]) {
    const result = await h.fetch(`/login?iterations=${iterations}`, { method: "POST", body: JSON.stringify({ password: fixtures.FAKE_PASSWORD }) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).tokenRoundTrip, true);
  }
  assert.equal((await h.fetch("/login", { method: "POST", body: JSON.stringify({ password: "FAKE_WRONG_PASSWORD" }) })).status, 401);
  // The 100,000 cap is enforced by Cloudflare's edge, not local workerd: record the local answer, assert only 100,000.
  const cap = await (await h.fetch("/__spike/pbkdf2-cap?iterations=100000", { method: "POST" })).json();
  assert.equal(cap.accepted, true);
});

test("local-only spike rejects non-loopback Host requests", async (t) => {
  const h = await harness(); t.after(() => h.close());
  assert.equal((await h.mf.dispatchFetch("https://example.com/login", { method: "POST" })).status, 403);
});
