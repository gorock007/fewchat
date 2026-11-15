The one Cloudflare Worker (see `docs/adr/0002-free-first-cloudflare.md`): `fetch` (a Hono app for `/api/*` and `/oauth/*`), `queue()` (delivery consumer) and `scheduled()` (cron sweep). Everything else is served from the static export in `out/`. Run it with `pnpm dev:worker`; its tests run Miniflare through the Vitest `worker` project.

- `app.ts` — the Hono app: `GET /api/health`, the webhook routes, JSON 404.
- `webhook.ts` — `GET`/`POST /api/webhooks/instagram`.
- `consumer.ts` — `handleDeliveryBatch`: what `queue()` runs for each message.
- `deps.ts` — `deliveryDependencies(env)`: the one factory both `queue()` and `scheduled()` build their delivery dependencies from.
- `sweep.ts` — `runSweep`: what `scheduled()` runs every minute.
- `refresh.ts` — `refreshDueToken`: the sweep's daily long-lived token refresh.
- `harness.ts` — test helper: bundles the Worker and runs it in Miniflare with the `wrangler.jsonc` bindings, `migrations/*.sql` applied, fake secrets (`FAKE_ENV`) and, with `spyQueue`, a `DELIVERY_QUEUE` spy whose sends tests can read or make throw. Every outbound `fetch` from the Worker is answered by a fake Meta origin (`meta.requests` records them, `meta.respond` scripts the answer), so tests drive the real `graph.instagram.com` code path without the network; `env` overrides a fake binding.

## Webhook ingest

`GET` is Meta's subscription check: the challenge comes back as text for the right `hub.verify_token`, otherwise 403.

`POST`, in order:

1. Config: `parseEnv(env)` on every request. A config error is a 500 with an empty body.
2. Signature: `readSignedBody` reads at most 32 KB and checks `X-Hub-Signature-256` over the raw bytes before anything parses them. Missing or wrong → 401; too large → 413.
3. Parse: invalid JSON → 400.
4. Normalize (`src/ingest/normalize.ts`): every `comments` change, from the `changes[]` envelope or `field`/`value` on the entry. A change without an account, comment or media ID is dropped.
5. Look up, once per account (`entry[].id`), in one D1 batch: the account (`accountByInstagramUserIdQuery`) and its active automations for the payload's media (`activeAutomationsQuery`), both by index. Nested replies and author-less comments are dropped before this, so a payload of only those reads nothing.
6. Decide each comment (`src/ingest/plan.ts`, using `matchComment` and `checkEligibility`) and write the account's comments with one `recordEvents` batch.
7. Enqueue: after the writes, one `{ deliveryId }` message per newly created `QUEUED` delivery (`sendBatch` when more than one). A send failure is logged as one line (`webhook_enqueue_failed`, with a count) and swallowed: the row stays `QUEUED` and the sweep picks it up.
8. 200. A D1 error anywhere in 5–6 is a 500 so Meta redelivers; deliveries already committed for an earlier account in the payload are still enqueued.

What each comment writes:

| Comment | Rows | Message |
|---|---|---|
| Matches, inside the window | event + `QUEUED` delivery | yes |
| Matches, commenter already holds the once-per-user slot | event + `SKIPPED` (`once_per_user`) | no |
| Matches, outside the private-reply window | event + `SKIPPED` (`outside_window`) | no |
| Redelivery of a recorded comment | nothing new | no |
| Unknown or `disconnected` account | nothing | — |
| Media with no active automation | nothing | — |
| By the account itself (`from.id` = its Instagram user ID) | nothing | — |
| Nested reply (any `parent_id`) | nothing | — |
| No `from.id` (self-exclusion cannot be checked) | nothing | — |
| Text the trigger does not match (or empty text) | nothing | — |

Writing nothing for an excluded comment leaves the (account, comment) slot free, so recovery (2c) can still record it from Meta's own data.

Paused sends (`app_settings.sends_paused`) change nothing here: deliveries are still `QUEUED` and enqueued, and the consumer checks the pause. An account in `needs_reconnect` is recorded the same way.

The event row's `payload` keeps only the comment, media and author IDs; the comment text (first 140 code points) and username are on the delivery alone, so retention purges one table. Logs carry event names, reasons and counts only: never tokens, secrets, comment text, usernames or the payload. A D1 error is logged by its name only, since its message can include bound values.

### `comment_created_at` is approximate

The webhook carries no creation time, so `comment_created_at` is `entry[].time` (seconds → ms). Meta documents that as the notification's send time, which is never earlier than the comment's creation. So the window can look longer than it is by the notification's delay; the hour of safety margin in `checkEligibility` absorbs a normal delay, not a redelivery days later. Recovery (2c) reads real `timestamp`s from the Comment node and should use those. A payload without `entry[].time` uses the receive time.

## Queue and sweep

`queue()` and `scheduled()` are thin: each builds `deliveryDependencies(env)` and hands over. If `parseEnv` fails, `queue()` retries every message (one fixed log line, no detail) and `scheduled()` logs the same and returns, so nothing is sent or lost until the config is fixed. `deliveryDependencies` wraps `fetch` (`(request) => globalThis.fetch(request)`) because the Meta client calls it as a method, which workerd rejects on the bare function.

The queue is an accelerator and D1 is the record (ADR 0002 Decision 3), so the cron sweep (`* * * * *`) must work without it, including once the daily queue quota is gone. It never sends to the queue: it processes inline. Per tick, in order:

1. `quarantineStaleSending` (60 s, limit 25): `SENDING` rows claimed over a minute ago become `DELIVERY_UNKNOWN`. They are never reset, because the claim may have reached Meta.
2. `refreshDueToken`: at most one account whose token is due (below).
3. `pendingDeliveries` due at least 60 s ago (`SWEEP_OVERDUE_MS`), oldest first, at most `SWEEP_BATCH_LIMIT` (5). The 60 s margin keeps the sweep off rows whose queue message is about to be handled, so they are not doubled.
4. `processDelivery` on each, sequentially. A row that throws is counted by fixed class (`BeforeClaimError` or `ClaimOrProcessingError`, never the message) and the sweep goes on. Pause, reconnect and rate-limit gates leave their rows pending, as in the consumer, so an unpause is picked up on the next tick.
5. `app_settings.last_sweep_at` is written once, after the work: the Health page's liveness signal. If step 1 or 3 throws (D1 is down), it is not written.
6. One JSON log line: `{ event: "sweep", quarantined, refreshed, refresh_failed, processed: { <result>: n }, errors: { <class>: n } }`. Counts only.

Five is the cap because each row is a D1 claim, one Meta call and a D1 write against a Worker invocation's 50 subrequests and 10 ms CPU (ADR 0002 Step 1 gates 3 and 6). A backlog drains at 5 rows a minute; the queue carries the normal load.

A row that always throws at claim time stays the oldest due row and takes one of the five slots every tick. Five of them would stall the sweep, so a poisoned row is something to alert on, not just to skip.

### Token refresh

A long-lived Instagram token lasts 60 days and Meta refuses to refresh one under 24 hours old (`docs/research/meta-api.md` §2.2). `refreshDueToken` picks one account per tick that is `connected`, has a token, has under 7 days left, was issued (`token_refreshed_at`) at least 24 hours ago (null counts as old enough) and has no refresh attempt (`token_refresh_attempted_at`) in the last hour; the soonest to expire goes first.

1. Stamp `token_refresh_attempted_at`, conditional on the ciphertext just read (a reconnect makes it a no-op).
2. Decrypt and call `refreshToken`. Success: new envelope, `token_expires_at` from the returned `expires_in`, `token_refreshed_at` = now, all conditional on the old ciphertext.
3. `token_invalid` or `permission_denied` (and a token that cannot be decrypted): `markNeedsReconnect`, conditional as for a send. Anything else leaves the account alone; the stamp makes the retry an hour later.

The sweep counts `refreshed` and `refresh_failed` (0 or 1 each). A thrown error is counted as `errors.RefreshError` and the sends go on. The token and Meta's failure text are never logged.
