# ADR 0001: Build FewChat as a smaller application using selected upstream patterns

## Status

Accepted — 2026-11-15. This decides code reuse for the implementation phases; live Meta feasibility remains gated by Phase 0. **Build a smaller application; do not fork AutoDM or OpenReply.**

## Context

FewChat needs one account, one administrator, immediate resource delivery in the first private reply, durable PostgreSQL jobs, and no automatic resend of uncertain deliveries. The stack is already fixed: Next.js App Router, strict TypeScript, Drizzle, PostgreSQL, Vitest and Playwright. Follower gates, billing, additional providers and multi-account SaaS are excluded. Source: [PRD §§6–10, 14, 21](../PRD.md), audited at FewChat commit `286e2879fa2c2a97b9dab392048a545d6fcff416` (`docs/PRD.md`).

### Audit basis and maintenance

Both repositories were cloned outside FewChat and inspected without installing dependencies or executing upstream code. All upstream file citations below are pinned to the full audited commit. Test counts are tracked `*.test.ts[x]`/`*.spec.ts[x]` files, not executed tests or coverage percentages.

| Repository | Audited revision and latest commit date | Maintenance evidence | License |
|---|---|---|---|
| AutoDM | [`e32f451c58f02d95f45f1215e97db2f0292b833d`](https://github.com/ilramdhan/auto-dm/commit/e32f451c58f02d95f45f1215e97db2f0292b833d), 2026-10-25, release 0.8.2 | 50 reachable commits since 2026-08-17; 46 test files; CI provisions PostgreSQL and runs lint, format, typecheck, tests, migrations and application build. Recent development, with no guarantee of future support. [CI][A-ci], [test configuration][A-vitest] | MIT; Copyright (c) 2026 Ilham Ramadhan. [LICENSE][A-license] |
| OpenReply | [`c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09`](https://github.com/diwenne/openreply/commit/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09), 2026-10-28, workspace API/MCP addition | 71 reachable commits since 2026-08-17; 34 test files; CI runs typecheck, lint, tests and build but provides no test PostgreSQL service or `TEST_DATABASE_URL`. Recent expansion increases the code FewChat would have to remove. [CI][O-ci], [test configuration][O-vitest] | MIT; Copyright (c) 2026 Anish Raj **and** Copyright (c) 2026 Diwen Huang. [LICENSE][O-license] |

The complete direct dependency inventories appear below. They are manifest ranges, not a vulnerability scan or a statement that every transitive dependency is safe. Neither upstream install/build script was run. [AutoDM manifest][A-package], [OpenReply manifest][O-package]

### AutoDM: relevant-file audit

| File / function | Useful behavior | Changes required for FewChat |
|---|---|---|
| [`src/server/instagram/oauth.ts`][A-oauth]: `createOAuthState`, `verifyOAuthState`, `completeOAuth`, `subscribeWithDetails` | Random signed state tied to a cookie, timing-safe comparisons; code → short token → long token; validates response shapes; obtains professional `user_id`; records subscription outcome. | Request only the two documented MVP scopes and subscribe only to `comments`. Remove postbacks. Require confirmed `success: true` rather than accepting an absent success field. See [Meta fact sheet](../research/meta-api.md). |
| [`src/server/instagram/inbound.ts`][A-inbound]: `readRawBody`, `authenticateWebhook`; [`webhook.ts`][A-webhook]: `verifySignature`, `extractCommentEvents` | HMAC-SHA256 on raw text before JSON parsing; length check and `timingSafeEqual`; validates header syntax; bounds declared and actual payload size; normalizes comments and filters unrelated objects/fields. Signature verification is **not** an ordinary string comparison. | Preserve raw bytes, cap bytes while streaming (its undeclared oversized body is fully read before rejection), persist normalized events before acknowledging. Hydrate comment creation time and parent status where absent. Its large numeric ID preservation depends on newer JSON reviver support; require exact strings or a lossless parser. |
| [`src/app/api/webhooks/instagram/route.ts`][A-route]: `POST` | Fast response and separated authentication. | **Reliability gap:** returns 200 before `after()` records diagnostics or creates deliveries. A process exit/DB outage can lose acknowledged work. Replace with transactional durable event/job insertion before 200. |
| [`src/server/engine/process-comment.ts`][A-engine]: `processCommentEvent`, `claimRule`, `sendForDelivery` | Unique comment insertion; transaction-scoped advisory lock serializes once-per-user claims; account/self-comment checks; separate DM/public results. | Public reply happens **before** DM; pause permanently skips instead of retaining queue entries; webhook event has no creation timestamp for a seven-day check; DM ambiguity is stored as ordinary failed/partial. Failed sends are not included in the once-per-user reservation set. Rebuild the pipeline, keeping the claim concept. |
| [`src/server/db/schema.ts`][A-schema] | Encrypted token column, delivery uniqueness and audit fields. | Global comment uniqueness rather than account + comment; no durable jobs table; no explicit uncertainty/expiry/retry states; unnecessary multi-rule, multi-post, follow-gate fields. Design to PRD rather than transplanting schema. |
| [`src/server/instagram/graph.ts`][A-graph]: `graphRequest`, `GraphApiError`, `safeErrorMessage` | Timeouts, schemas, bounded read retries, path-only diagnostics, token redaction helper; avoids timeout/5xx retries for non-idempotent sends. | It can retry HTTP 429 internally; put send retries under durable scheduling instead. `mayHaveBeenApplied` only covers status 0/5xx, missing HTTP-200 malformed/invalid success responses and possible code-1 ambiguity. Ensure all exception/log paths use redaction. |
| [`src/server/crypto.ts`][A-crypto], [`account.ts`][A-account], [`log.ts`][A-log] | AES-256-GCM with random IV and purpose-separated HKDF keys; encrypted account writes; refreshes with 15-day expiry headroom; logger redacts sensitive keys and error details. No plaintext token persistence was found in these paths. | Use a FewChat-specific versioned key format and rotation plan. Refresh scheduler must check token age ≥24h and unexpired status; `refreshTokenIfNeeded` itself does not enforce that age. Its [cron route][A-cron] is scheduled daily by [vercel.json][A-vercel]; FewChat must supply and verify its own worker schedule. |
| [`src/server/engine/match.ts`][A-match]: `keywordMatches`, `matchComment` | Pure matching and Unicode-aware normalization behind testable functions. | Exact mode strips punctuation/mentions and accents; that is broader than PRD's trimmed whole-comment equality. Only any-comment mode excludes nested replies; FewChat must exclude them for every trigger. Port test ideas and write FewChat semantics. |

The reviewed AutoDM route/engine/schema provide direct sequential sends, not a durable worker, periodic comment reconciler or shared account send-budget reservation. Reactive Graph throttling is insufficient for FewChat’s queue and rolling-hour limiter. Its configured cron is token refresh/retention only. [Route][A-route], [engine][A-engine], [schema][A-schema], [Graph client][A-graph], [Vercel cron configuration][A-vercel]

### OpenReply: relevant-file audit

| File / function | Useful behavior | Changes required for FewChat |
|---|---|---|
| [`lib/meta/client.ts`][O-client]: `sendPrivateReply`, `sendCommentReply`, `getRecentMediaComments`, `handleResponse` | Correct comment-addressed JSON send shape; bearer header for sends; preserves code/subcode/trace; bounded pagination; centralized Graph version. | Send fetches lack explicit deadlines; unchecked response casts can accept missing message IDs. `100` is grouped with permission errors and `368` with rate limits, losing important distinctions. Long-token exchange/refresh URLs use a versioned base, while current docs specify unversioned endpoints. Bound/sanitize errors and reconstruct pagination URLs on the allowed host. |
| [`lib/queue/comment-delivery.ts`][O-claim]: `claimCommentDelivery` | Conditional atomic update, durable unconfirmed flag set **before** the network side effect, attempt count survives jobs; independent DM/public claims. | Reimplement with Drizzle/PostgreSQL and account + comment uniqueness; add transactional once-per-commenter reservation. The worker’s cross-campaign check only reads already-SENT rows, so it does not serialize competing campaigns; account-wide uniqueness must close that race. [Worker][O-worker] Do not let lease expiry clear evidence that sending may have started. |
| [`lib/queue/dm-worker.ts`][O-worker]: `processComment`, `processJob` | Checks durable flags across retries, retains uncertain claims, stops BullMQ retries for uncertainty; preserves sent state if final persistence fails. | Public reply still runs first; job data lacks comment creation time, so it cannot enforce seven-day eligibility at send time. Remove billing, tracking, provider dispatch, follow gates, opening DMs, read-triggered reveals and follow-ups. Classifier must separate permanent rejection from safe-to-retry rejection; ordinary token/permission exceptions can otherwise enter queue retries. |
| [`lib/instagram/delivery-errors.ts`][O-errors]: `classifySendError`, `isConfirmedSendRejection` | Network, parse, local-persistence and generic Meta code-1 outcomes conservatively become unconfirmed; uncertainty blocks resend. | Useful policy, **not** authoritative Meta code documentation. Explicit rejection means no confirmed send, not necessarily permission to retry. Use an allowlist of verified transient rejection categories. |
| [`lib/polling/comment-reconciler.ts`][O-reconciler]: `reconcileComments`, `sweepCampaign` | Active campaign scan, 72-hour default lookback, bounded enqueue (30/campaign), oldest-first, durable attempt/uncertainty checks, common queue pipeline. | Does not enqueue creation timestamps; considers an owner's public reply a reason to skip, which is not proof of DM delivery. Remove that inference, ad/workspace/provider logic and blanket claims about which comments never trigger webhooks. Missing timestamps must not become eligible by default. |
| [`lib/queue/client.ts`][O-queue]: `getDMQueue` | Durable queue, retry backoff, retention policies, identifiable jobs. | BullMQ + Redis adds another state store and separate DB/queue writes. Keep job intent inside the same PostgreSQL transaction as event/delivery state. Do not transplant Redis or broad job union. |
| [`lib/utils/rate-limiter.ts`][O-rate]: `reserveDMSlot`, `releaseDMSlot` | Lua atomically reserves a shared account slot before sends. | First-use one-hour TTL counter is **not a rolling-hour limiter** and permits boundary bursts; cap 750 has no headroom. Release can affect a later window because reservation has no window identity, and `DECR`/`DEL` is not one atomic operation. Use shared PostgreSQL reservations, 600/rolling hour and a burst cap. Count dispatched attempts conservatively, including ambiguous outcomes and possibly rejected calls. |
| [`lib/meta/oauth.ts`][O-oauth], [`connect`][O-connect], [`callback`][O-callback] | AES-256-GCM token storage; signed expiring workspace state; callback checks authenticated membership. | State contains workspace/time, no one-time nonce bound to the initiating browser/session. This is a replay/account-linking defense gap, not a demonstrated exploit. Use AutoDM's cookie-bound approach plus one-use state. Requests messages/insights unnecessarily. Exchange parses only flat token JSON while Meta also documents a `data` array. Callback logs raw errors and adds error text to redirects; sanitize these paths. |
| [`app/api/webhook/route.ts`][O-route], [`lib/meta/webhook.ts`][O-webhook], [`lib/queue/process-webhook.ts`][O-process] | POST hashes raw text with timing-safe comparison, then persists event and queues before successful response; failure returns 500. Account IDs are filtered to connected accounts. | Invalid signatures still cause first 200 raw body characters to be stored; valid full payloads persist. This violates FewChat's minimization requirement. No request-body limit; signature accepts either configured secret (use the precise integration key). GET verification token uses ordinary equality. Parser omits `parent_id`, so another user's nested reply can trigger. DB event and Redis job writes are not atomic. |

### Tests and dependency risks

AutoDM has signature/parser and client tests plus real-PostgreSQL tests for duplicate comments and concurrent once-per-user claims. Its integration tests skip without `TEST_DATABASE_URL`; CI supplies that database. Matching tests are useful but encode upstream semantics that FewChat must change. [Webhook tests][A-webhook-test], [client tests][A-graph-test], [engine integration tests][A-engine-test], [matching tests][A-match-test], [CI][A-ci]

OpenReply has mocked worker, reconciliation and limiter tests, and a database claim test exercising concurrent callers, lost result writes and attempt budgets. The database test skips without `TEST_DATABASE_URL`, which its checked-in CI does not supply. These are valuable regression scenarios, not evidence of live Meta behavior. Neither tree contains a tracked Playwright configuration or conventional e2e test suite; AutoDM's Playwright dependency is used for demo tooling. No coverage percentages or upstream pass results were measured. [Claim tests][O-claim-test], [worker tests][O-worker-test], [reconciler tests][O-reconciler-test], [limiter tests][O-rate-test], [CI][O-ci], [AutoDM manifest][A-package]

AutoDM is closer to FewChat's stack, but its default `build` runs migrations before Next.js; copying that script would couple deployment and database mutation. Native Argon2/esbuild tooling adds platform/install considerations. OpenReply adds Prisma generation, Redis/BullMQ, beta NextAuth, email, analytics and charting, and its `vercel-build` runs migrations. Neither manifest needs to be imported wholesale. This is a dependency/surface-area review, **not a CVE audit**; future dependency choices need their own locked-tree review. [AutoDM manifest][A-package], [OpenReply manifest][O-package]

### Options

| Option | Benefit | Cost / fit |
|---|---|---|
| Fork AutoDM and remove features | Existing single-admin UI, Drizzle models, OAuth, crypto and substantial tests. | Replaces the central webhook/delivery lifecycle anyway; must remove follow gating, multi-rule targeting and n8n features, change pause/public-reply ordering and add durable worker/reconciliation. Creates a large upstream merge surface. [Engine][A-engine], [route][A-route], [schema][A-schema] |
| Build smaller, borrowing selected patterns | Keeps the fixed stack and implements PRD states, transactions and boundaries directly; reuses reviewed ideas and test scenarios. | Owns new queue/worker implementation and verification; does not inherit a complete UI or upstream fixes automatically. Pattern sources and required adaptations are enumerated above and below. |

## Decision

**Build FewChat as a smaller application on the prescribed stack, borrowing narrowly scoped patterns from both repositories. Do not fork either repository.** AutoDM is the primary reference for login, token protection, normalization and single-admin product behavior. OpenReply is the reference for durable claims, independent action state, bounded reconciliation and conservative uncertainty. The comparison above and PRD §§8, 10 and 14 justify this decision.

The following is the approved reuse map, not a claim that code has already been copied. New implementations should have a small API boundary and FewChat-specific tests. Any actual copied/adapted implementation or tests trigger the notice step below.

| Pattern / specific functions to adapt | Source file at audited revision | FewChat destination responsibility | Notice if copied |
|---|---|---|---|
| `createOAuthState`, `verifyOAuthState`, `completeOAuth` | [AutoDM `src/server/instagram/oauth.ts`][A-oauth] | Server-only OAuth; one-use state; two scopes; validated exchange/profile | AutoDM MIT |
| `verifySignature`, `checkVerifyRequest`, `extractCommentEvents` | [AutoDM `src/server/instagram/webhook.ts`][A-webhook] and [`inbound.ts`][A-inbound] | Raw-byte authentication, bounded input, normalized durable ingest | AutoDM MIT |
| `encrypt`, `decrypt`, `refreshTokenIfNeeded` | [AutoDM `src/server/crypto.ts`][A-crypto] and [`instagram/account.ts`][A-account] | Versioned token envelope; scheduled, age-aware refresh | AutoDM MIT |
| `graphRequest`, `safeErrorMessage` | [AutoDM `src/server/instagram/graph.ts`][A-graph] | Typed response validation, deadlines, redacted errors; durable send retry policy | AutoDM MIT |
| `sendPrivateReply`, `sendCommentReply` request shapes | [OpenReply `lib/meta/client.ts`][O-client] | Thin Meta adapter; validate IDs; public reply only after accepted DM | OpenReply MIT if code copied; protocol itself is documented by Meta |
| `claimRule` locking idea | [AutoDM `src/server/engine/process-comment.ts`][A-engine] | Transactional once-per-user reservation including uncertain sends | AutoDM MIT |
| `claimCommentDelivery`, `classifySendError`, `isConfirmedSendRejection` | [OpenReply `lib/queue/comment-delivery.ts`][O-claim], [`lib/instagram/delivery-errors.ts`][O-errors] | Atomic state transition before external call; preserve uncertainty across crashes | OpenReply MIT |
| `reconcileComments`, `sweepCampaign`, `getRecentMediaComments` | [OpenReply `lib/polling/comment-reconciler.ts`][O-reconciler], [`lib/meta/client.ts`][O-client] | Paginated recovery through the same ingest pipeline, per-comment timestamps and durable dedup | OpenReply MIT |
| Atomic reservation concept from `reserveDMSlot` | [OpenReply `lib/utils/rate-limiter.ts`][O-rate] | New PostgreSQL rolling-window limiter and short-burst control; no Redis/Lua port | OpenReply MIT if adapted code copied |
| Duplicate/concurrency/lost-write test scenarios | [AutoDM engine tests][A-engine-test], [OpenReply claim tests][O-claim-test], [worker tests][O-worker-test] | Real PostgreSQL race/crash verification plus mocked HTTP behavior | Corresponding upstream MIT if tests copied |

Do not port either send orchestrator, schema, queue infrastructure, rate-window implementation, exact-match semantics, dependency manifest, follow-gate flow or raw-payload diagnostics unchanged. Those exclusions follow the concrete gaps in the audit tables.

### License notice requirements

If implementation code or tests are copied/adapted, the implementing worker must add an entry in root `THIRD_PARTY_NOTICES.md` with upstream project URL, audited commit, copied source paths, FewChat destination paths, applicable copyright lines, and the **complete MIT license text including its permission condition and warranty disclaimer**. Preserve existing source headers when present. Keep FewChat's own MIT license; it does not replace upstream notices. AutoDM requires `Copyright (c) 2026 Ilham Ramadhan`; OpenReply requires **both** `Copyright (c) 2026 Anish Raj` and `Copyright (c) 2026 Diwen Huang`. This derives from the licenses' inclusion condition. [AutoDM LICENSE][A-license], [OpenReply LICENSE][O-license]

This documentation-only audit copies no upstream implementation or tests, so it does not create `THIRD_PARTY_NOTICES.md`; that file is outside this brief. Record actual reuse when it happens, including modifications. Do not copy upstream logos/fonts/assets under the assumption that a source-code license covers every bundled asset.

## Consequences

- FewChat owns a new durable pipeline. Acceptance requires database race/crash tests, webhook persistence before acknowledgement, retry scheduling, once-per-user protection, lease recovery that preserves ambiguous sends, pause/resume and independent public-reply state. These are PRD §§6, 8, 10 and 17 obligations, not guarantees inherited from either project. [PRD](../PRD.md)
- Less product and infrastructure code needs maintaining. In exchange, upstream updates require deliberate review and selective adaptation with provenance rather than automatic merges. The excluded dependencies and behaviors are documented above.
- Current Meta facts belong in [the fact sheet](../research/meta-api.md). Use Instagram Login with basic + comments scopes and a central `v27.0` pin, subject to the documented version-page discrepancy and a successful live probe. Never infer API permission or error-code semantics solely from upstream code.
- **UNVERIFIED — needs live test (Phase 0):** non-tester/non-follower comments, access level requirements, payload omissions and endpoint-specific error tuples. Own-account Standard Access guidance conflicts with current webhook Advanced Access requirements. Local mocks do not release this gate. [Meta App Review](https://developers.facebook.com/documentation/instagram-platform/app-review), [Meta webhook setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)
- Meta now recommends Unified Login for new integrations but says existing Instagram Login integrations continue without an announced end date. Keep the PRD's selected integration for Phase 0; do not mix Unified Login's host, tokens or permissions into it. If the real app cannot provision Instagram Login, Jarvis must revisit this API choice before live operation. [Meta migration guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide)

### Complete direct dependency inventory

Versions below reproduce declared ranges at the audited commits; lockfiles were not installed or audited for advisories.

#### AutoDM

Source: [`package.json`][A-package].

| Kind | Package | Declared version |
|---|---|---|
| Runtime | `@hookform/resolvers` | `^5.9.1` |
| Runtime | `@node-rs/argon2` | `^2.2.2` |
| Runtime | `class-variance-authority` | `^0.7.1` |
| Runtime | `clsx` | `^2.1.1` |
| Runtime | `drizzle-orm` | `^0.45.4` |
| Runtime | `jose` | `^6.2.12` |
| Runtime | `lucide-react` | `^1.56.0` |
| Runtime | `next` | `16.4.1` |
| Runtime | `next-themes` | `^0.4.6` |
| Runtime | `postgres` | `^3.4.9` |
| Runtime | `radix-ui` | `^1.8.1` |
| Runtime | `react` | `19.3.0` |
| Runtime | `react-dom` | `19.3.0` |
| Runtime | `react-hook-form` | `^7.90.0` |
| Runtime | `server-only` | `^0.0.1` |
| Runtime | `sonner` | `^2.0.8` |
| Runtime | `tailwind-merge` | `^3.7.0` |
| Runtime | `zod` | `^4.6.7` |
| Development | `@eslint/eslintrc` | `^3` |
| Development | `@tailwindcss/postcss` | `^4` |
| Development | `@types/node` | `^22.20.5` |
| Development | `@types/react` | `^19` |
| Development | `@types/react-dom` | `^19` |
| Development | `dotenv` | `^18.0.7` |
| Development | `drizzle-kit` | `^0.31.11` |
| Development | `esbuild` | `^0.28.2` |
| Development | `eslint` | `^9` |
| Development | `eslint-config-next` | `16.4.1` |
| Development | `playwright` | `^1.64.0` |
| Development | `prettier` | `^3.9.10` |
| Development | `prettier-plugin-tailwindcss` | `^0.8.1` |
| Development | `tailwindcss` | `^4` |
| Development | `tsx` | `^4.23.15` |
| Development | `tw-animate-css` | `^1.4.0` |
| Development | `typescript` | `^6.0.3` |
| Development | `vite` | `^8.3.4` |
| Development | `vitest` | `^5.0.4` |

#### OpenReply

Source: [`package.json`][O-package].

| Kind | Package | Declared version |
|---|---|---|
| Runtime | `@auth/prisma-adapter` | `^2.11.2` |
| Runtime | `@prisma/adapter-pg` | `^7.8.0` |
| Runtime | `@prisma/client` | `^7.8.0` |
| Runtime | `@vercel/analytics` | `^2.0.1` |
| Runtime | `bullmq` | `^5.76.4` |
| Runtime | `ioredis` | `^5.10.1` |
| Runtime | `next` | `^16.2.6` |
| Runtime | `next-auth` | `^5.0.0-beta.31` |
| Runtime | `nodemailer` | `^7.0.13` |
| Runtime | `pg` | `^8.20.0` |
| Runtime | `react` | `19.2.4` |
| Runtime | `react-dom` | `19.2.4` |
| Runtime | `recharts` | `^3.8.1` |
| Runtime | `zod` | `^4.3.6` |
| Development | `@tailwindcss/postcss` | `^4` |
| Development | `@types/node` | `^20` |
| Development | `@types/nodemailer` | `^8.0.1` |
| Development | `@types/pg` | `^8.20.0` |
| Development | `@types/react` | `^19` |
| Development | `@types/react-dom` | `^19` |
| Development | `babel-plugin-react-compiler` | `1.0.0` |
| Development | `eslint` | `^9` |
| Development | `eslint-config-next` | `^16.2.6` |
| Development | `prisma` | `^7.8.0` |
| Development | `tailwindcss` | `^4` |
| Development | `tsx` | `^4.22.1` |
| Development | `typescript` | `^5` |
| Development | `vitest` | `^4.1.5` |

[A-license]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/LICENSE
[A-package]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/package.json
[A-ci]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/.github/workflows/ci.yml
[A-vitest]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/vitest.config.ts
[A-engine]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/engine/process-comment.ts
[A-inbound]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/inbound.ts
[A-route]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/app/api/webhooks/instagram/route.ts
[A-webhook]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/webhook.ts
[A-oauth]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/oauth.ts
[A-schema]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/db/schema.ts
[A-crypto]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/crypto.ts
[A-account]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/account.ts
[A-graph]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/graph.ts
[A-log]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/log.ts
[A-constants]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/constants.ts
[A-match]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/engine/match.ts
[A-match-test]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/engine/match.test.ts
[A-webhook-test]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/webhook.test.ts
[A-graph-test]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/graph.test.ts
[A-engine-test]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/tests/engine/process-comment.test.ts
[O-license]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/LICENSE
[O-package]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/package.json
[O-ci]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/.github/workflows/ci.yml
[O-vitest]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/vitest.config.ts
[O-client]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/meta/client.ts
[O-worker]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/queue/dm-worker.ts
[O-claim]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/queue/comment-delivery.ts
[O-reconciler]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/polling/comment-reconciler.ts
[O-queue]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/queue/client.ts
[O-rate]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/utils/rate-limiter.ts
[O-errors]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/instagram/delivery-errors.ts
[O-oauth]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/meta/oauth.ts
[O-callback]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/app/api/instagram/callback/route.ts
[O-connect]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/app/api/instagram/connect/route.ts
[O-route]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/app/api/webhook/route.ts
[O-webhook]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/meta/webhook.ts
[O-process]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/queue/process-webhook.ts
[O-claim-test]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/__tests__/comment-delivery.test.ts
[O-worker-test]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/__tests__/dm-worker.test.ts
[O-reconciler-test]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/__tests__/comment-reconciler.test.ts
[O-rate-test]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/__tests__/rate-limiter.test.ts
[A-cron]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/app/api/cron/refresh-tokens/route.ts
[A-vercel]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/vercel.json
