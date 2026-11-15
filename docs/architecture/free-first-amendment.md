# FewChat — Architecture Decision Amendment: Free-first, serverless

**Decision:** Free-first, serverless architecture  
**Replaces:** Infrastructure and deployment decisions in `docs/PRD.md` (§8, §10 deployment parts, §13 self-hostability)  
**Priority:** High  
**Constraint:** Preserve existing implementation wherever practical  
**Status:** Accepted by the project owner on 2026-11-15, with the two adjustments below. Final shape is recorded in `docs/adr/0002-free-first-cloudflare.md` after the compatibility spike.

## Adjustments agreed before the spike

These override the corresponding parts of the amendment text below.

1. **Frontend: static export first, vinext second.** Build the existing Next.js
   dashboard with `output: 'export'` and serve it as Workers static assets
   (no CPU per page view, no RSC rendering against the 10 ms CPU limit). All
   server logic lives in the Worker's `/api` routes. Still run `vinext check`
   and record the result; choose vinext only if the spike shows it is clearly
   better and fits the CPU limit.
2. **One Worker, not two.** A single Worker serves the static dashboard and
   handles `fetch()` (API, OAuth callback, Meta webhook), `queue()` and
   `scheduled()`. Same origin for auth; one deploy; one D1 binding. Split out
   a webhook Worker later only if a separate hostname becomes necessary.
3. **Queues vs `waitUntil` decided by the spike.** Option A: Cloudflare Queues
   (if on the Workers Free plan). Option B: webhook persists to D1, responds,
   then processes in `ctx.waitUntil()`, with a 1-minute cron sweep as the
   safety net. D1 is the source of truth either way.
4. **Design for known CPU risks:** password hashing (Web Crypto PBKDF2, tuned
   and measured; bcrypt/argon2 excluded), and the ~50 subrequests per
   invocation limit (reconciliation batched and resumable).
5. **Vercel fallback** remains a last resort only (Hobby plan is non-commercial).

---

## Context

FewChat is already under development using the original PRD, which proposes Next.js, PostgreSQL, a standalone Node.js background worker, and deployment across Vercel and Fly.io/Railway.

We want to change the infrastructure direction before introducing unnecessary hosting dependencies.

The primary objective is to make FewChat genuinely free to run for individual creators within reasonable free-tier usage limits.

FewChat will remain open source and self-hostable. Each user should be able to deploy their own instance using their own Cloudflare and Meta accounts.

**This is an architecture amendment, not a product rewrite. Do not restart the project or discard existing work.**

## 1. New architecture decision

Adopt Cloudflare as the preferred hosting platform.

| Component | Updated decision |
|---|---|
| Frontend | Keep existing Next.js and React |
| UI | Keep Tailwind CSS and shadcn/ui |
| Application hosting | Cloudflare Workers (static export; vinext evaluated) |
| Webhooks | Cloudflare Worker endpoint |
| Database | Cloudflare D1 (SQLite) |
| ORM | Drizzle with D1/SQLite dialect |
| Background processing | Cloudflare Queues or `waitUntil` + cron (spike decides) |
| Scheduled tasks | Cloudflare Cron Triggers |
| Meta integration | Existing official Meta API implementation |
| Authentication | Existing approach, adapted for Workers |
| Deployment | Wrangler and Workers configuration |
| Docker / Redis / always-on Node worker | Removed |

No mandatory paid services for normal low-volume personal usage. No Cloudflare paid-plan dependencies. Free-tier quotas, usage failures and platform restrictions must be handled gracefully.

## 2. Preserve Next.js

Do not migrate the frontend to another framework for consistency's sake. Inspect the app, run `npx vinext check`, review warnings, identify unsupported Node APIs/middleware/packages, test a production build on Workers Free, and measure actual CPU per request. Workers Free has a 10 ms CPU limit per invocation: avoid unnecessary server-side work for dashboard pages. If vinext has significant incompatibilities, document the blockers. Fallback: Next.js on Vercel's free tier with only webhook/background on Cloudflare, documenting cross-origin auth, callback URLs and restrictions. Do not change framework unless both are unsuitable.

## 3. Worker structure (superseded by adjustment 2)

Originally two Workers: an App Worker (dashboard, admin auth, automation management, OAuth callbacks, history, D1, enqueuing admin/recovery jobs) and a Background Worker (`fetch()` webhooks, `queue()` delivery, `scheduled()` reconciliation, token refresh, retries, rate limiting, delivery state). Hono may be used for routing; avoid unnecessary frameworks. Prefer direct bindings over a distributed-service design.

## 4. Database: PostgreSQL → D1

D1 is the production database. Keep Drizzle, migrate the dialect. Audit the Postgres schema (archived on branch `archive/postgres-schema-queue`), identify Postgres-specific types/expressions/queries, convert to SQLite equivalents, preserve delivery uniqueness and transactional guarantees, adapt indexes and foreign keys, build the client from the D1 binding, update tests and fixtures, verify migrations and query performance. Do not blindly translate SQL. Watch: atomic delivery claims, once-per-user, duplicate webhooks, timestamp representation, concurrency, transactions and uniqueness, failed-job recovery. D1 is the durable source of truth for comments, automations, deliveries and job state; a queue is never the only record of pending work.

## 5. Replace the always-on worker

Flow: Meta webhook → validate signature → write event to D1 → record pending delivery and enqueue its id → respond promptly → consumer atomically claims → checks eligibility and rate limits → sends private reply → persists result in D1.

Persistence must succeed before returning success to Meta; if persistence fails, return a failure. If persistence succeeds but enqueueing fails, a scheduled recovery task finds and enqueues the pending delivery. Queue messages carry identifiers only — no personal data or tokens.

## 6. Queue retention and reliability

Free-plan Queues retain messages 24 hours, so queues are never permanent storage. D1 holds pending state, retry schedule, attempt counts, claim state, Meta message ids, error classification, delivery uncertainty and timestamps.

A scheduled recovery task: finds pending deliveries with no active processing, re-enqueues safe jobs, recovers abandoned **pre-send** claims, marks expired comments, respects the seven-day window, and never re-enqueues confirmed, permanently failed or DELIVERY_UNKNOWN deliveries. Never blindly retry a request that may have reached Meta (the PRD's at-most-once policy for uncertain sends). Idempotent consumers; bounded retries with exponential backoff and jitter; graceful handling of free-tier exhaustion.

## 7. Cron Triggers

Reconciliation every 10 minutes initially (configurable); token refresh and housekeeping daily. Stay within Workers Free. Each scheduled invocation does bounded work within CPU, subrequest and database quotas: small batches of active automations, persisted cursors where useful, work spread across invocations, no unbounded comment-history rescans, the existing dedup mechanism, Meta API limits respected. If work doesn't finish, persist progress and resume. Tolerate delayed or missed invocations.

## 8. Free-tier constraints

Design against the current Workers Free plan (validate every number against official docs during implementation):

| Resource | Free-tier allowance (to verify) |
|---|---|
| Workers requests | 100,000/day |
| Workers CPU | 10 ms per invocation |
| D1 storage | 500 MB per database |
| D1 rows read | 5 million/day |
| D1 rows written | 100,000/day |
| Queues operations | 10,000/day |
| Queue retention | 24 hours |
| Cron Triggers | 5/account |

The target is $0/month for low-volume creator usage, not guaranteed unlimited hosting. Safeguards against excessive polling, unbounded pagination, excessive writes, retry loops, high-frequency schedules, excessive webhook logging, and full-table dashboard queries. Indexed queries, configurable retention. If quotas are exhausted, preserve state and report clearly rather than silently losing messages.

## 9. Runtime compatibility

Workers is not a long-running Node environment. Audit dependencies for Node built-ins, filesystem access, TCP drivers, timers, crypto, package compatibility, env handling, long-running processes. Prefer Web Crypto for webhook HMAC and token encryption. Use bindings, not connection pools. Use Node compatibility flags only where required. Measure CPU for webhook verification, authentication, queue processing, Meta response handling and reconciliation (network waits don't count as CPU; parsing, crypto and logic do).

## 10. Deployment

Cloudflare Workers, D1, Queues (if chosen), Cron Triggers, and the provided `workers.dev` domain (custom domain optional). Not required: Docker, Redis, Fly.io, Railway, a VPS, an always-on server, a paid database. Native local development with local D1 migrations and a way to simulate queue and scheduled events.

## 11. Product requirements unchanged

All PRD functional scope stays: professional-account connection, official Meta API, comment-triggered automations, keyword and any-comment matching, resource in the first private reply, no follower verification or follow gating, optional public replies, single-account self-hosting, dashboard and activity history, dedup, global pause, security and privacy. No new product features in this migration.

## 12. Migration strategy

1. **Audit** what exists (UI, Next features, schema, worker, queue, Meta integration, tests, deployment config).
2. **Compatibility spike**: static export / vinext on Workers, D1 with Drizzle, queue producer/consumer, cron, Meta API calls, webhook HMAC — within free-tier CPU limits using realistic payloads.
3. **Migration decision**: a brief ADR (existing vs proposed architecture, code preserved, code migrated, risks, complexity, reasons).
4. **Incremental implementation**, one concern at a time: deployment compatibility → database adapter and migrations → queue abstraction → background processing → cron → webhook endpoint → auth and secrets → integration tests → remove unused hosting infrastructure. Don't delete working code before its replacement passes tests.
5. **Validation**: webhook ingestion, persistent storage, queue processing, private reply, duplicate prevention, retry recovery, cron reconciliation, token refresh, dashboard, free-tier deployment. Live Meta testing stays a separate acceptance requirement.

## 13. Deliverables

ADR for the free-first design; updated infrastructure diagram; D1 schema and migrations; Worker deployment configuration; queue (or `waitUntil`) integration; Cron Trigger configuration; updated environment configuration; free-tier deployment guide; updated architecture tests; migration notes; free-tier limitations and operating constraints. Don't rewrite the PRD, rebuild the UI unnecessarily, or add infrastructure outside this scope.

## Final instruction

Reduce hosting cost to $0 for normal small-scale usage while preserving reliability and existing progress. Avoid complexity for theoretical scalability. Prefer Cloudflare-native, event-driven infrastructure. Keep Next.js unless evidence justifies changing it. The result: a small, reliable, open-source app an individual creator can deploy without paying for an always-on server.
