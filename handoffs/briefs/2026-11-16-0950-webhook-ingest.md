# Step 2a: Instagram webhook ingest — verify, normalize, match, persist, enqueue
worker: claude
model: claude-opus-5-5
effort: high
started: 2026-11-16 09:46 · terminal: 7a80b840-079d-48a6-8540-c370cac878ac
budget: min=90

## Goal
`/api/webhooks/instagram` on the Worker handles Meta's GET verification and
signed POSTs: it verifies the signature on the raw bytes, normalizes each
comment, decides per comment (excluded / no match / QUEUED / SKIPPED) with the
existing domain functions, writes event + delivery rows in one `db.batch`
**before** answering 200, then sends one queue message per new QUEUED
delivery, swallowing send failures. Done = Miniflare tests drive a signed
fixture through the real Worker and see the right D1 rows and queue messages,
and `pnpm lint && pnpm typecheck && pnpm test && pnpm build` pass.

## Context
- Spec: `docs/PRD.md` §5.3, FR-04 (triggers + **Exclusions**), FR-06, FR-10
  (paused still records), §7.3; `docs/research/meta-api.md` §5.2–5.3 (payload
  shape, `entry[].time` is notification time); `docs/adr/0002-free-first-cloudflare.md`
  Decision 3 (persist before ack; queue is an accelerator; send failure
  swallowed) and Step 1 gate 2 (rows/day).
- Previous phases (read their handoffs, don't re-derive):
  `handoffs/merged/2026-11-16-0922-cf-infra.md` (Worker, harness),
  `handoffs/merged/2026-11-16-0938-d1-schema.md` (`recordEvents` /
  `recordEventStatements` in `src/db/deliveries.ts`, schema, `src/db/test-d1.ts`),
  `handoffs/merged/2026-11-16-0935-meta-client.md` (`verifySubscription`,
  `readSignedBody` in `src/meta/webhook.ts`; fixtures + `signFixture`-style
  helper in `src/meta/fixtures.ts`).
- Domain functions to call, not reimplement: `matchComment`
  (`src/domain/matching.ts`), `checkEligibility` (`src/domain/eligibility.ts`).
- Rulings already made (don't reopen):
  - Path is `/api/webhooks/instagram` (PRD §7.3). Remove `"/webhook"` from
    `run_worker_first` in `wrangler.jsonc`; `/api/*` already covers it.
  - Read config per request with `parseEnv(c.env)`; a config error is a 500
    with no detail in the body.
  - Order: signature → parse JSON (malformed → 400) → normalize → look up the
    account(s) by `entry[].id` and their active automations for the media in
    the payload (one query per entry at most) → decide → one `recordEvents`
    call per entry → 200. A D1 error → 500 so Meta redelivers. Bad/missing
    signature → 401; too large → 413.
  - Write nothing (no event row, no delivery) for: unknown or disconnected
    account; media with no active automation; comment by the account itself
    (`from.id` = the account's IG user id); nested replies (a `parent_id` in
    the value); a comment the automation's trigger doesn't match. Comments that
    match but fail eligibility are a `SKIPPED` delivery with a `skip_reason`
    (`outside_window` etc.); once-per-user is the DB's job (`oncePerUser`
    flag), not a pre-read.
  - `commentCreatedAt` = `entry[].time` converted to epoch ms (the fact sheet
    says it is send time; it is ≥ creation time — note this in the README for
    2c's recovery path, which gets real timestamps).
  - Paused (`app_settings.sends_paused` or the account's) changes nothing here:
    deliveries are still QUEUED and enqueued; the consumer (2b) checks pause.
  - After the batch commits, `DELIVERY_QUEUE.send({ deliveryId })` for each
    newly created QUEUED delivery only (not redeliveries), via
    `sendBatch` when more than one; catch and log any failure as one
    structured line with no payload, token or username, and still 200.
  - Never log tokens, secrets, comment text, usernames or the payload.
  - Keep the handler cheap (10 ms CPU): no Meta API calls in the webhook.

## Scope
- May touch: `src/ingest/`, `src/worker/app.ts`, `src/worker/webhook.ts`, `src/worker/webhook.worker.test.ts`, `src/worker/harness.ts`, `src/worker/README.md`, `src/db/automations.ts`, `src/db/accounts.ts`, `wrangler.jsonc`, `tsconfig.worker.json`
- Must not touch: `src/db/schema.ts`, `src/db/deliveries.ts`, `migrations/`, `src/meta/`, `src/domain/`, `src/config/`, `src/app/`, `package.json`, `pnpm-lock.yaml`, `spike/`, `docs/`, `handoffs/` (except your handoff), git
- Shared files (edit minimally, name in handoff): `wrangler.jsonc`, `tsconfig.worker.json`

## Phase
1. `src/ingest/normalize.ts`: payload → `NormalizedComment[]` (account id,
   comment id, media id, from id/username, text, parent id, notification time),
   tolerant of both the `changes[]` envelope and missing optional fields;
   ignores non-`comments` fields. Pure; unit-tested (`*.test.ts`).
2. `src/ingest/plan.ts`: `(comment, account, automation | undefined, now)` →
   `RecordEventInput | null` using `matchComment` and `checkEligibility`. Pure;
   unit-tested for every exclusion above and keyword vs any-comment.
3. `src/db/accounts.ts` / `src/db/automations.ts`: the two lookups (read-only,
   indexed; reuse existing indexes — if one is missing, say so in the handoff,
   don't add a migration).
4. `src/worker/webhook.ts`: the Hono routes; mount in `app.ts`. Add
   `src/ingest/**/*.ts` to `tsconfig.worker.json` `include`.
5. Harness: extend `src/worker/harness.ts` so the Worker's D1 has
   `migrations/*.sql` applied and fake secrets bound (fake values only), and so
   tests can read queue messages sent (or make `send` throw).
6. `src/worker/webhook.worker.test.ts`: GET verify ok / wrong token 403;
   POST missing / tampered signature 401; 33 KB → 413; malformed JSON 400;
   matching comment → one event + QUEUED delivery + one queue message;
   same payload again → no new rows, no message; self-comment, nested reply,
   no-automation media, non-matching text → no rows; outside window → SKIPPED;
   queue `send` throwing → still 200 and the delivery stays QUEUED; D1 failure
   → 500; two comments in one payload → two deliveries, one batch; an
   `/webhook` request now falls to assets (not the Worker).
7. `src/worker/README.md`: the ingest flow, what is written for each case,
   and the `commentCreatedAt` approximation.

## Checks
```bash verify class=light timeout=600
pnpm lint && pnpm typecheck && pnpm test 2>&1 | tail -15 && pnpm build >/dev/null && ! grep -n '"/webhook"' wrangler.jsonc
```

## Questions first
Put every question in one first handoff (`status: blocked`) and stop. After
the answers arrive on your terminal, finish this phase without stopping
again. If you have no questions, build straight through.
