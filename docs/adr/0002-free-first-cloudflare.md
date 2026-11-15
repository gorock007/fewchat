# ADR 0002: Free-first Cloudflare — one Worker, static-export dashboard, D1, Queues with a D1 safety net

## Status

Accepted — 2026-11-15, subject to the Step 1 gates below. This records the outcome of the compatibility spike in `spike/` and supersedes the infrastructure parts of ADR 0001 and PRD §8, §10 (deployment) and §13 (self-hosting) as amended by [`docs/architecture/free-first-amendment.md`](../architecture/free-first-amendment.md). The spike was throwaway code with fake data; nothing in it called Meta.

## Context

The amendment moves FewChat to Cloudflare so a creator can run it for free, with the five adjustments recorded at its top: static export first (vinext second), one Worker, Queues-versus-`waitUntil` decided by evidence, designed-in CPU/subrequest limits, and Vercel only as a last resort. The spike had to answer those questions with measurements, not recollection.

### Method

- `spike/` is a self-contained project with its own `package.json` and lockfile. A single Worker (`spike/src/index.ts`) serves the **static export** of the real Next app (`NEXT_OUTPUT=export pnpm build` → `out/`) and implements `POST /webhook` (raw-body HMAC, D1 insert via Drizzle `db.batch`, then dispatch by Queue **or** `ctx.waitUntil`, behind `PROCESSING_MODE`), a D1 conditional claim, a `queue()` consumer, a `scheduled()` sweep, and `POST /login` (PBKDF2-SHA256 plus AES-GCM). The Meta call is a stub fetch to a mock; payloads and the signing secret are synthetic (from the [Meta fact sheet](../research/meta-api.md) §5.3), never captured data.
- **Local**: 13 integration tests in Miniflare (real workerd, local D1, local Queues): signature rejection, atomic batch rollback, duplicate/concurrent ingress, concurrent claim, cron rediscovery, uncertain-outcome non-resend. Plus Node microbenchmarks (`spike/scripts/bench.mjs`).
- **Deployed**: the same Worker deployed to a Workers **Free** account (confirmed: Cloudflare rejected a `limits.cpu_ms` setting with *"CPU limits are not supported for the Free plan"*), with D1 `fewchat-spike-db` and queue `fewchat-spike-q`. Per-invocation `cpuTime` comes from `wrangler tail --format json`. `wrangler tail` drops events under bursts, so request bursts were paced; sample counts (`n`) are given and are small. Treat the figures as order-of-magnitude evidence, not a benchmark.

## Verified Workers Free limits

Read from Cloudflare's current documentation on 2026-11-15.

| Limit (Workers Free) | Value | Source |
|---|---|---|
| CPU time per HTTP request / per Cron Trigger | 10 ms | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Requests per day | 100,000 (resets 00:00 UTC) | Workers limits |
| Subrequests per invocation | 50 | Workers limits |
| Cron Triggers per **account** | 5 | Workers limits |
| Static assets: files per Worker version / file size | 20,000 / 25 MiB | Workers limits |
| Static asset requests | "free and unlimited"; only requests that invoke the Worker are billed/limited (a `run_worker_first` request over the free quota gets 429) | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 storage / databases | 500 MB per database, 5 GB per account, 10 databases | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 queries per Worker invocation | 50 | D1 limits |
| D1 rows read / written per day | 5,000,000 / 100,000 | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) |
| **Queues on Workers Free** | **Available**: 10,000 operations/day, fixed 24 h retention; an operation is each 64 KB written, read or deleted, per message; retries add reads | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| Queue limits | consumer batch ≤ 100; `sendBatch` ≤ 100 messages / 256 KB; `delaySeconds` ≤ 24 h; retries ≤ 100 | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Web Crypto PBKDF2 iteration cap | **Not in the docs** (the Web Crypto page lists PBKDF2 without a limit). **Measured below: 100,000 is the maximum.** | measured |

A queued message costs about three operations (write, read, delete), so the free queue budget is roughly **3,300 messages/day** when nothing is retried. That figure is derived from the pricing rule, not measured.

## Results

CPU time is Cloudflare's reported `cpuTime` per invocation on the deployed Free-plan Worker unless marked *local*. *Local* values are Node `process.cpuUsage`, median of 10–200 runs, and indicate relative cost only.

| Path | Deployed CPU (ms) | Local CPU (ms) | Notes |
|---|---|---|---|
| Static asset (`GET /`) | **no Worker invocation** | n/a | Never appeared in `wrangler tail`; served by the assets layer |
| `POST /webhook`, Queue mode (1 comment) | median 4, range 2–9 (n=10) | HMAC 0.03, JSON.parse 0.004, Drizzle build 0.03 | HMAC + 2-statement D1 batch + `sendBatch`. First request after deploy was the 9 |
| `POST /webhook`, `waitUntil` mode (1 comment) | median 6, range 4–8 (n=5) | — | Includes the send, claim and finish in the same invocation |
| `queue()` consumer, 1 message | median 3, range 1–9 (n=10) | — | Claim + stub fetch + finish; each message gets its own invocation and CPU budget. The five runs where the stub send succeeded (the others hit the error-1042 failure below) were 1–4 |
| D1 claim (`UPDATE … RETURNING`) | 3–8 (n=2) | 0.04 build | Two concurrent claims → exactly one winner (local test and deployed) |
| PBKDF2-SHA256 login, 10,000 iterations | median 3, 2–4 (n=8) | 1.1 | includes one AES-GCM round-trip |
| … 25,000 | median 5, 4–10 (n=7) | 2.5 | |
| … 50,000 | median 10, 8–12 (n=6) | 5.0 | |
| … 100,000 | median 17, 14–22 (n=9) | 9.6 | |
| AES-GCM encrypt + decrypt of a short token | below measurement resolution | 0.07 | |
| Stress: 1/2/4/8/16 × PBKDF2-100k in one request | 17 / 32 / 65 / 136 / 245 | — | every one returned 200 on Free |

Other measured facts:

- **PBKDF2 cap**: the deployed runtime rejects 100,001 and 200,000 iterations with `Pbkdf2 failed: iteration counts above 100000 are not supported`; 100,000 is accepted. **Local workerd does not enforce the cap**, so local tests cannot catch a work factor above 100,000.
- **Observed CPU enforcement is much looser than the documented 10 ms.** 100,000-iteration PBKDF2 (14–22 ms) and a 245 ms request both completed with `outcome: ok` on a Free account, and no 1102 error appeared. The documented limit is still 10 ms; Cloudflare may enforce it differently later or elsewhere. Do not design to the leniency.
- **Queue latency**: the delay from webhook insert to the consumer claiming the row was 3.6–6.9 s for the eight queue-delivered messages in two bursts (`max_batch_timeout: 1`, `max_batch_size: 1`); the same measure was about 40 ms in `waitUntil` mode (n=5). Queue mode is a few seconds slower to first send; this only matters if the product promises near-instant delivery.
- **A Worker cannot fetch its own `workers.dev` URL** (Cloudflare error 1042). The spike's mock had to use a service binding to itself. This affects only the spike's stub; Graph API calls go to Meta's hosts.
- **Static export**: with Next 16.4.6 the export fails with `Invariant: PPR cannot be enabled in export mode` while `cacheComponents` and `partialPrefetching` are on. `next.config.ts` now sets both (and `output`) from `NEXT_OUTPUT`: `NEXT_OUTPUT=export pnpm build` produces `out/`; plain `pnpm build` is unchanged (standalone, both features on) and still passes.
- **`npx vinext check`** (run on a copy; read-only to the repo): **90% compatible (8 supported, 2 partial, 0 issues)**. Partial: `turbopack` (the `rules`/loaders config is ignored — the app's CSS rule would not apply) and `cacheComponents` (experimental, behaviour incomplete). `next/font/google`, Tailwind, lucide-react and zod are supported.
- **Cron on Free works, but a new schedule is slow to start.** A `* * * * *` trigger fired for the first time roughly a quarter of an hour after it was first deployed (about the 15 minutes Cloudflare documents for trigger propagation), and my later redeploys may have restarted that wait. Once running, one sweep (n=1 in `waitUntil` mode) found an orphaned `QUEUED` row inserted straight into D1 with no webhook, sent it exactly once, and moved the two stale `SENDING` rows to `DELIVERY_UNKNOWN` without re-sending them. That invocation reported 17 ms CPU (it included the send path), `outcome: ok`. A queue-mode sweep only enqueues, so it should cost less; this was not measured.

## Decision

1. **Frontend: static export, not vinext.** The dashboard is built with `NEXT_OUTPUT=export` and served as Workers static assets: free, unlimited, and no Worker invocation (verified) — so page views spend none of the 100,000 requests/day or 10 ms CPU. vinext would put React rendering inside the 10 ms budget and is only partially compatible (above). Cost: static export drops `cacheComponents` and `partialPrefetching`, and with them Server Actions, route handlers, middleware/proxy and any dynamic rendering. Everything dynamic moves to the Worker's API; the dashboard fetches it from the browser. Keep both settings gated on `NEXT_OUTPUT` so the standalone build and its tests keep working until the migration removes it.
2. **One Worker — confirmed.** It served static assets, `fetch` (webhook, login, API), `queue()` and `scheduled()` from one deployment with one D1 binding and one origin. `assets.run_worker_first` takes an explicit list of Worker-handled paths (`/webhook`, `/login`, `/api/*`, the OAuth callback); everything else is asset-served without invocation. A request that matches nothing falls to the assets layer, so the list is part of the contract and needs a test.
3. **Dispatch: Queues, with D1 as the source of truth and a 1-minute cron sweep as the safety net.** Queues are available on Workers Free. Chosen over `waitUntil` because each queued message gets its own invocation and CPU budget (`waitUntil` shares the webhook's budget across every comment in a payload, and the measured webhook already costs 4–8 ms for one), and because `delaySeconds` and retries are the natural primitives for the rolling-hour rate limiter. Caveats that shape the design:
   - The webhook always writes event + delivery to D1 in one `db.batch` **before** acknowledging, and a queue-send failure is swallowed (the row stays `QUEUED`) — verified by test. The queue is an accelerator, never the record.
   - The free queue allows about 3,300 messages/day. When it is exhausted, or `send` fails, the sweep must carry the load. The sweep's throughput is bounded by 10 ms CPU, 50 subrequests and 50 D1 queries per invocation (roughly 5–15 deliveries a minute), below the 600/hour product ceiling. **What the Queues API does when the daily quota is exhausted was not tested** and must be before Step 1 relies on it.
   - `waitUntil` mode worked end to end and is the documented fallback; the same `processDelivery` serves both.
   - Message ack is not exactly-once. The send path claims the row first (`QUEUED → SENDING` by conditional `UPDATE … RETURNING`), any uncertain outcome becomes `DELIVERY_UNKNOWN`, and nothing re-sends it: queue redelivery, a repeated cron sweep, and a malformed, disconnected or 5xx mock all resulted in exactly one send (tests).
4. **Password hashing: PBKDF2-HMAC-SHA256 at 100,000 iterations, stored per hash.** 100,000 is the platform maximum. At 14–22 ms it exceeds the documented 10 ms limit by 1.4–2.2×, but ran without error on Free across all samples including a 245 ms stress request, and login is rare (single administrator, session cookie). Store `pbkdf2-sha256$<iterations>$<salt>$<hash>` so the work factor can be lowered without a migration (re-hash at next login), and require a long generated administrator password at setup (≥ 16 random characters or a passphrase), because the iteration count is far below current OWASP guidance for PBKDF2-SHA256 (600,000) and cannot be raised on Workers. Rate-limit attempts in D1. Fallback if Cloudflare starts returning 1102 on login: 50,000 (median 10 ms), then 25,000 (median 5 ms). bcrypt and argon2 stay excluded; they would need WASM and far more CPU. Verify equality with the native HMAC `verify` trick used in `spike/src/crypto.ts`, not string comparison.
5. **AES-GCM token encryption** is negligible CPU; use a versioned envelope with a random 96-bit IV and associated data naming the purpose and account.
6. **Webhook signature** uses `crypto.subtle.verify("HMAC", …)` on the raw bytes (constant-time), after a streaming size cap of 32 KB. At 0.03 ms local it is irrelevant to the budget.

## Step 1 gates and risks

1. **CPU-limit leniency is not a contract.** Re-run the login path on the real deployment, watch for 1102 for a week, and keep the iteration count configurable. A local-only check proves nothing: Miniflare enforces neither the 10 ms limit nor the PBKDF2 cap.
2. **D1 write budget.** 100,000 rows written/day. Indexes count, so one comment's event insert, delivery insert, claim update and finish update plus index maintenance is plausibly 8–12 rows: roughly **8,000–12,000 comments/day** before D1 refuses writes. This is an estimate from the pricing rule, not measured. Keep the schema lean, avoid per-comment log rows, and check `meta.rows_written` on the deployed spike before settling the schema.
3. **Per-invocation caps in reconciliation.** 50 subrequests and 50 D1 queries per invocation; whether one `db.batch` counts as one query was not tested. Reconciliation must page, be resumable from a D1 cursor, and cap work per tick. The spike's sweep selects 5 rows per tick for exactly this reason.
4. **Queue quota behaviour** (point 3 above) and whether queue consumer invocations count toward the 100,000 requests/day were not verified.
5. **Cron limits are per account.** Five Cron Triggers across every Worker the creator owns; FewChat needs one. The 1-minute sweep is 1,440 invocations/day and counts against the 10 ms budget each time.
6. **`stale SENDING` is quarantined, never reset.** The sweep moves `SENDING` rows older than 60 s to `DELIVERY_UNKNOWN`. Production needs a lease design (and a visible way for the owner to resolve unknowns); the spike only proves it never re-sends.
7. **Static dashboard is public.** Every HTML/JS file is world-readable. No secrets in the bundle; authorization lives only in the Worker API, and the API path list must be kept in sync with `run_worker_first`.
8. **Local D1 is not production D1.** The atomic-batch rollback was proven in Miniflare only; confirm the same on a deployed D1 before depending on it for the acknowledged-event guarantee. The deployed run proved only that batch insert succeeds and that two concurrent claims produce one winner.
9. **Tooling.** `wrangler tail` drops events under load, so measurement in Step 1 should use Workers Observability or the GraphQL analytics API with a scoped token. A self-hosting user's `workers.dev` subdomain contains their account name; document custom-domain setup.
10. **Spike-only workarounds that must not leak into the app:** the loopback/`SPIKE_ACCESS_KEY` gate, the fake-ID allowlist, the self-service-binding mock, and the `__spike/*` routes.

## What ports from `archive/postgres-schema-queue`

Read-only review of the archived design (`src/db/schema.ts`, `src/db/queue.ts`):

- **Ports as-is (semantics):** the `delivery_status` vocabulary (`RECEIVED`, `SKIPPED`, `QUEUED`, `SENDING`, `SENT`, `RETRYABLE_FAILED`, `PERMANENT_FAILED`, `DELIVERY_UNKNOWN`, `EXPIRED`) with the rule that `DELIVERY_UNKNOWN` is never auto-resent; the `(account, comment)` unique index; the once-per-user partial unique index (`counts_toward_once_per_user`, SQLite supports partial indexes and Drizzle's `.where()`); the claim-before-send order; and the abandoned-lease recovery that marks rather than retries. The spike's `deliveries` table already uses the same states and `QUEUED → SENDING` claim.
- **Needs translation:** `uuid` → app-generated text IDs; `timestamptz` → integer epoch milliseconds (the spike's choice); `pgEnum` → text with a `CHECK` constraint (Drizzle's SQLite `enum` option only types it; the spike adds the check explicitly); `jsonb` → JSON text.
- **Replaced:** `FOR UPDATE SKIP LOCKED` and advisory locks have no D1 equivalent. Claims become a conditional `UPDATE … WHERE status='QUEUED' RETURNING` (proven), and exclusion comes from unique indexes. The `jobs` table (run-after, lock leases, retry attempts) is largely superseded by Queues' retries and `delaySeconds`; keep a slimmer sweep record only if needed. Multi-statement transactions become `db.batch`.
- **Still needed:** the rolling-hour limiter. It must be a D1 reservation (or a Durable Object, which is outside the free-first scope) and its writes count against the 100,000 rows/day budget.

## Consequences

- The product runs on a single free Cloudflare account with no always-on server, at the cost of a hard ceiling (order of thousands of comments per day) and a few operational caveats above.
- The dashboard must become a client-rendered app over a JSON API, and the migration needs a Drizzle SQLite dialect and migrations in `wrangler`'s D1 format.
- Vercel remains a last-resort fallback only; this decision does not close it.

## Teardown of the spike resources

Nothing was deleted by the spike worker. These resources exist on the creator's Cloudflare account until removed; none needs a config file:

```bash
cd spike
pnpm exec wrangler delete --name fewchat-spike        # Worker, its cron trigger and SPIKE_ACCESS_KEY secret
pnpm exec wrangler queues delete fewchat-spike-q
pnpm exec wrangler d1 delete fewchat-spike-db
```

The deployed run used a git-ignored `wrangler.deploy.jsonc` holding the real database ID and account-specific URL; it is not in the repository.
