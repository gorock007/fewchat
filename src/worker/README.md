The one Cloudflare Worker (see `docs/adr/0002-free-first-cloudflare.md`): `fetch` (a Hono app for `/api/*` and `/oauth/*`), `queue()` (delivery consumer) and `scheduled()` (cron sweep). Everything else is served from the static export in `out/`. Run it with `pnpm dev:worker`; its tests run Miniflare through the Vitest `worker` project.

- `app.ts` — the Hono app: `GET /api/health`, the webhook routes, JSON 404.
- `webhook.ts` — `GET`/`POST /api/webhooks/instagram`.
- `harness.ts` — test helper: bundles the Worker and runs it in Miniflare with the `wrangler.jsonc` bindings, `migrations/*.sql` applied, fake secrets (`FAKE_ENV`) and, with `spyQueue`, a `DELIVERY_QUEUE` spy whose sends tests can read or make throw.

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
