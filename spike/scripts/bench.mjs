// Local CPU microbenchmarks (Node, not workerd): relative cost of each handler's CPU-bound work.
import { importSource, fixtures, signedBody } from "./harness.mjs";
const crypto_ = await importSource("src/crypto.ts");
const dbm = await importSource("src/db.ts");

async function cpuMs(fn, runs = 30) {
  for (let i = 0; i < 3; i++) await fn();
  const times = [];
  for (let i = 0; i < runs; i++) {
    const before = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(before);
    times.push((d.user + d.system) / 1000);
  }
  times.sort((a, b) => a - b);
  return { median: +times[Math.floor(runs / 2)].toFixed(3), p95: +times[Math.floor(runs * 0.95)].toFixed(3) };
}
const { body, signature } = signedBody();
const buf = new TextEncoder().encode(body).buffer;
const bigPayload = JSON.stringify({ object: "instagram", entry: Array.from({ length: 5 }, () => JSON.parse(body).entry[0]) });
const results = {};
results["HMAC-SHA256 verify (webhook body)"] = await cpuMs(() => crypto_.verifySignature(buf, signature, fixtures.FAKE_SECRET));
results["JSON.parse (5-entry batch)"] = await cpuMs(() => JSON.parse(bigPayload), 200);
for (const n of [10000, 25000, 50000, 100000]) {
  results[`PBKDF2-SHA256 ${n} iterations`] = await cpuMs(() => crypto_.verifyPassword(fixtures.FAKE_PASSWORD, fixtures.FAKE_HASHES[n], fixtures.FAKE_SALT, n), 10);
}
results["AES-GCM encrypt+decrypt (fake token)"] = await cpuMs(() => crypto_.tokenRoundTrip());
const fakeDb = dbm.database({ prepare() { throw new Error("not used"); } });
results["Drizzle build: insert event+delivery batch (no I/O)"] = await cpuMs(() => dbm.insertStatements(fakeDb, { id: "a", accountId: "b", commentId: "c", receivedAt: 1 }).map((q) => q.toSQL()), 200);
results["Drizzle build: claim UPDATE..RETURNING (no I/O)"] = await cpuMs(() => dbm.claimStatement(fakeDb, "a", 1).toSQL(), 200);
console.table(results);
