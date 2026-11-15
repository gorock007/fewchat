# Step 2a: Instagram webhook ingest — verify, normalize, match, persist, enqueue
status: done
agent: claude claude-opus-5-5
brief: handoffs/briefs/2026-11-16-0950-webhook-ingest.md

## What the user asked
`/api/webhooks/instagram` on the Worker: Meta's GET verification, and signed POSTs that are verified on the raw bytes, normalized, decided per comment (excluded / no match / QUEUED / SKIPPED) with the existing domain functions, written as event + delivery rows in one `db.batch` before the 200, then enqueued one message per new QUEUED delivery, with send failures swallowed. Proven by Miniflare tests through the real Worker.

## What changed
- **`src/ingest/normalize.ts`** — `normalizeWebhook(payload) → NormalizedComment[]` (account ID, comment ID, media ID, from ID/username, text, parent ID, `notifiedAt` in ms). Reads the `changes[]` envelope, `field`/`value` on the entry itself, and `value` given as an array. Ignores non-`comments` fields and `object !== "instagram"`. A change with no account, comment or media ID is dropped. IDs must be strings. Any non-empty `parent_id` (of any type) counts as nested. `entry[].time` is converted from seconds; a value already in ms is kept. Pure; 20 unit tests.
- **`src/ingest/plan.ts`** — `planComment(comment, account, automation | undefined, now) → RecordEventInput | null`. Returns `null` (write nothing) for: an unknown or `disconnected` account, a nested reply, a missing `from.id`, a self-comment, no automation (or one for another media), or a trigger that doesn't match. A match inside the window gives `QUEUED`; outside it gives `SKIPPED` with `skip_reason = "outside_window"`. Event key is `comments:<commentId>`. `commentCreatedAt` = `notifiedAt`, falling back to `now`. Pure; 18 unit tests, covering keyword vs any-comment, the safety-margin edge and every exclusion.
- **`src/db/accounts.ts`** — `accountByInstagramUserIdQuery`. **`src/db/automations.ts`** — `activeAutomationsQuery(db, instagramUserId, mediaIds)`, joined on `instagram_user_id` so it needs no prior read, with a literal `is_active = 1` so SQLite can use the partial index. Both are read-only and return query builders. The webhook runs them together in one `db.batch`, so each account costs one D1 round trip. **The existing indexes are enough** (`instagram_accounts_instagram_user_id_unique`, `automations_one_active_per_media`); query-plan tests check both. No migration.
- **`src/worker/webhook.ts`** (mounted at `/api/webhooks/instagram` in `app.ts`):
  - GET returns the challenge for the right verify token, else 403.
  - POST order:
    1. `parseEnv`; a config error is an empty 500.
    2. `readSignedBody`: missing or bad signature → 401, too large → 413.
    3. `JSON.parse`: invalid JSON → 400.
    4. Normalize, then group the comments by `entry[].id`.
    5. Per account, one lookup batch, then plan each comment, then one `recordEvents` call.
    6. Enqueue, then 200.
  - Nested and author-less comments are dropped before the lookup, so they cost no read.
  - A D1 error → 500. Deliveries already committed for an earlier account in the same payload are still enqueued first.
  - Enqueue sends `{ deliveryId }` (`DeliveryMessage` type is exported), with `send` for one delivery and `sendBatch` for more. Only newly created QUEUED deliveries are sent, never redeliveries. A send failure is caught and logged as `{"event":"webhook_enqueue_failed","count":n}`.
  - Logs carry only event names, reasons and counts. A D1 error is logged by `error.name` only, because Drizzle's message includes bound values (comment text).
  - No Meta calls.
- **Pause** changes nothing here, as ruled; a test proves `sends_paused = 1` still queues and enqueues. **`needs_reconnect`** accounts are also recorded as QUEUED (only `disconnected` is excluded).
- **Event `payload`** stores only `{ commentId, mediaId, fromId }`. The text excerpt (first 140 code points) and the username live on the delivery only, so retention purges one table.
- **`wrangler.jsonc`** — `"/webhook"` removed from `run_worker_first`.
- **`src/worker/harness.ts`**:
  - Applies `migrations/*.sql` to the Worker's D1.
  - Binds `FAKE_ENV`, fake values for every `parseEnv` key; the app secret is `FAKE_SIGNING_SECRET` from `src/meta/fixtures.ts`.
  - Exposes `getD1()`.
  - Has a new `spyQueue` option. A Miniflare wrapped binding replaces the `DELIVERY_QUEUE` producer: each `send`/`sendBatch` call lands in `queue.calls`, or throws while `queue.failSends` is set. The consumer config is unchanged, and the default (no spy) still uses the real producer.
- **`src/worker/webhook.worker.test.ts`** — 23 tests:
  - GET: right token → 200, wrong token → 403.
  - POST rejections: missing signature 401, tampered body 401, 33 KB 413, malformed JSON 400.
  - Ingest:
    - A match gives one event, one QUEUED delivery and one message, and `comment_created_at` = `entry.time` in ms.
    - A redelivery adds no rows and sends no message.
    - Two comments → two deliveries, and one `sendBatch` call carrying both.
    - Repeat commenter → `SKIPPED once_per_user`, no message.
    - Outside the window → `SKIPPED outside_window`, no message.
    - Paused → still QUEUED and enqueued.
    - Queue throws → 200, and the delivery stays QUEUED.
  - Nothing written for: self-comment, nested reply, no-automation and inactive-automation media, non-matching text, unknown and disconnected accounts. Each also asserts a 200.
  - Two query plans.
  - `/webhook` is no longer a webhook (404, nothing written).
  - A separate Worker with `webhook_events` dropped → 500, no deliveries, no message.
- **`src/worker/README.md`** — the ingest flow, a table of what each case writes, logging rules, and the `comment_created_at` approximation for 2c.

## Files
- src/ingest/normalize.ts — created
- src/ingest/normalize.test.ts — created
- src/ingest/plan.ts — created
- src/ingest/plan.test.ts — created
- src/db/accounts.ts — created
- src/db/automations.ts — created
- src/worker/webhook.ts — created
- src/worker/webhook.worker.test.ts — created
- src/worker/app.ts — modified
- src/worker/harness.ts — modified
- src/worker/README.md — modified
- wrangler.jsonc — modified (shared file)
- tsconfig.worker.json — modified (shared file)
- handoffs/2026-11-16-0954-webhook-ingest.md — created (this file)

## Checks run
- The brief's check line: `pnpm lint && pnpm typecheck && pnpm test 2>&1 | tail -15 && pnpm build >/dev/null && ! grep -n '"/webhook"' wrangler.jsonc`, run with `bash -o pipefail` through `handoffs/bin/jarvis lock suite --reuse`. **Passed, exit 0.** Lint clean, both typechecks clean, 15 files / 368 tests passing (none skipped; `out/` was present, so the asset test ran), and the static export built. The brief's `light` lock class isn't configured in `handoffs/jarvis.conf`, so I used `suite`, as the meta-client worker did.
- `prettier --check` is clean on every file I touched.
- `handoffs/bin/jarvis leftovers --mine`: nothing running.
- **Not checked:**
  - Deployed Cloudflare behaviour.
  - Real Meta deliveries (the envelope and `parent_id` presence are still unverified until Phase 0).
  - The 10 ms CPU budget (not measured; the handler does one HMAC, one JSON parse, regex matching and two D1 round trips per account).
  - `rows_written` for the lookup batch (reads only; the write side is unchanged from 1b's table).
  - A real `Queue` producer under the spy. The spy replaces the binding, so the real `send` serialization limits aren't exercised.

## Processes left running
none

## Questions for the user
none

## Notes for Jarvis
- **Shared files:** `wrangler.jsonc` has one line changed (`"/webhook"` dropped from `run_worker_first`). `tsconfig.worker.json` adds `src/ingest/**/*.ts`.
- **The brief's "`/webhook` falls to assets (not the Worker)" doesn't quite hold, and can't be made to without a config change I wasn't asked for.** Without `run_worker_first`, the asset layer is checked first. But `wrangler.jsonc` sets no `assets.not_found_handling`, so a miss is still handed to the Worker, which answers Hono's JSON 404. The test asserts what is true: `/webhook` is a 404 and writes nothing. To make misses end at the asset layer, set `not_found_handling: "404-page"` (`out/404.html` exists). That would change `/api/*` misses too, so it's your call.
- **Decisions inside the rulings** (each is easy to undo):
  1. A comment with no `from.id` writes nothing: self-exclusion can't be checked, and writing nothing leaves the (account, comment) slot free for 2c's recovery.
  2. `needs_reconnect` accounts are recorded; only `disconnected` is excluded.
  3. Comments are grouped by `entry[].id`. Two entries for the same account become one lookup and one `recordEvents` call, still within "one per entry at most".
  4. Valid JSON with an unexpected shape (wrong `object`, no `entry`) is a 200 with nothing written; only unparseable JSON is a 400.
  5. Event `payload` is minimal (IDs only), and the excerpt is 140 code points.
  6. The 200 is awaited after the queue send (not `waitUntil`), so tests are deterministic. The send costs a little latency.
- `app_settings.last_webhook_at` is not stamped. It would add a write per webhook against gate 2. Whoever builds the Health page should decide.
- The harness duplicates `migrationStatements` from `src/db/test-d1.ts`, which doesn't export it and was outside my scope. Exporting it there would remove the copy.
- The delivery-consumer worker (2b) expects `{ deliveryId }`; that is what is sent (`DeliveryMessage` in `webhook.ts`).
- Suggested commit message: `feat(ingest): Instagram webhook ingest — verify, normalize, decide, persist before ack, enqueue`
