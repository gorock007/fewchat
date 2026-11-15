// Drives the deployed (or local `wrangler dev`) spike. SPIKE_URL and SPIKE_KEY come from the environment; fake data only.
import { createHmac } from "node:crypto";
import { fixtures } from "./harness.mjs";

const base = process.env.SPIKE_URL, key = process.env.SPIKE_KEY ?? "";
if (!base) throw new Error("set SPIKE_URL");
const prefix = process.env.SPIKE_PREFIX ?? "fake-run";
const headers = { "x-spike-access": key };
const call = async (path, init = {}) => {
  const started = performance.now();
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
  const text = await res.text();
  return { path, status: res.status, ms: +(performance.now() - started).toFixed(0), body: text.slice(0, 160) };
};
const log = (r) => console.log(JSON.stringify(r));

log(await call("/"));
for (let i = 0; i < 5; i++) {
  const value = structuredClone(fixtures.payload);
  value.entry[0].changes[0].value.id = `${prefix}-${i}`;
  const body = JSON.stringify(value);
  const signature = `sha256=${createHmac("sha256", fixtures.FAKE_SECRET).update(body).digest("hex")}`;
  log(await call("/webhook", { method: "POST", body, headers: { "x-hub-signature-256": signature } }));
}
for (const n of [10000, 25000, 50000, 100000]) {
  log(await call(`/login?iterations=${n}`, { method: "POST", body: JSON.stringify({ password: fixtures.FAKE_PASSWORD }) }));
}
for (const n of [100000, 100001, 200000]) log(await call(`/__spike/pbkdf2-cap?iterations=${n}`, { method: "POST" }));
log(await call(`/__spike/claim?id=${encodeURIComponent(`90000000000000001:${prefix}-0`)}`, { method: "POST" }));
await new Promise((r) => setTimeout(r, 8000));
for (let i = 0; i < 5; i++) log(await call(`/__spike/delivery?id=${encodeURIComponent(`90000000000000001:${prefix}-${i}`)}`));
