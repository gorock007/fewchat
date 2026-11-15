Persistence: Drizzle schema, client and queries over the D1 binding. The only place that talks to the database. Migrations are SQL files in `migrations/`, generated with `pnpm db:generate` and applied with `pnpm db:migrate:local`.

- `schema.ts` — the six tables (SQLite dialect): text IDs from `crypto.randomUUID()`, integer epoch-ms timestamps, text enums backed by a `CHECK`, JSON as text.
- `client.ts` — `getDb(d1)`.
- `deliveries.ts` — ingress batch and every delivery state transition (below).
- `test-d1.ts` — test helper: Miniflare with one D1 database and `migrations/*.sql` applied, plus fake-data fixtures. Tests are `*.worker.test.ts`.

`migrations/0000_init.sql` and `0002_operational_events_related_delivery_idx.sql` are generated. `0001_seed_app_settings.sql` is a `drizzle-kit generate --custom` file holding the single `app_settings` row. Never edit a generated migration; change `schema.ts` and run `pnpm db:generate` for a new one.

## Delivery state machine

Each transition is one conditional statement on the current status; none reads then writes. A statement that matches no row changed nothing and returns `false` / no row.

- *(webhook)* → `QUEUED` — `recordEventStatements`, in the webhook's `db.batch` with the event. `next_attempt_at` = received time. Takes the once-per-user slot when the automation has it on.
- *(webhook)* → `SKIPPED` — same batch: the comment will not be sent, or (`skip_reason = once_per_user`) the commenter already holds the slot. Never takes the slot.
- *(webhook)* → `RECEIVED` — recorded but not yet decided.
- `QUEUED` | `RETRYABLE_FAILED` → `SENDING` — `claimDelivery`. Sets `claimed_at`, adds 1 to `attempt_count`. Refused while the account has `perHour` claims in the last hour or `burstPerMinute` in the last minute (counting `SENDING`, `SENT`, `DELIVERY_UNKNOWN`); then returns `rate_limited` with `retryAt`.
- `SENDING` | `DELIVERY_UNKNOWN` → `SENT` — `finishDelivery`, with Meta's message ID and `sent_at`. Accepting `DELIVERY_UNKNOWN` lets a sender that outlived the stale-`SENDING` quarantine still record the success.
- `SENDING` → `RETRYABLE_FAILED` — `failDelivery`, with a new `next_attempt_at`. Claimable again.
- `SENDING` → `PERMANENT_FAILED` — `failDelivery`. Terminal.
- `SENDING` → `DELIVERY_UNKNOWN` — `failDelivery` when the outcome is uncertain, or `quarantineStaleSending` when the claim is older than 60 s (default). Nothing re-sends it, and nothing moves it to `QUEUED` or `RETRYABLE_FAILED` (`failDelivery` acts only from `SENDING`); its only way out is `finishDelivery`.
- `EXPIRED` — in the vocabulary; no transition writes it yet (the sweep or consumer will, past the private-reply window).

`pendingDeliveries` lists `QUEUED`/`RETRYABLE_FAILED` rows with `next_attempt_at <= now`, earliest first, up to a limit, for the cron sweep to enqueue.

## Indexes

Kept from the archive: `instagram_accounts.instagram_user_id` unique, `webhook_events.event_key` unique, `automations_one_active_per_media` (partial, `is_active = 1`), `deliveries_account_comment_unique`, `deliveries_once_per_user_unique` (partial, `counts_toward_once_per_user = 1`), `operational_events_created_at_idx`.

New: `deliveries_pending_idx` (partial, pending statuses) for the sweep; `deliveries_sending_idx` (partial, `SENDING`) for quarantine; `deliveries_account_claimed_at_idx` (partial, claimed rows) for the rate limit in the claim; `deliveries_created_at_idx` for the Activity page and retention purge; `operational_events_related_delivery_idx` so the `ON DELETE SET NULL` on `related_delivery_id` does not scan the table on every delivery delete. Partial-index predicates must appear in queries as literals (`oneOf` in `schema.ts`); SQLite cannot use a partial index against a bound parameter. A test checks each sweep/claim query's plan.

Dropped from the archive, with the reason:

- `jobs` and its two indexes — Queues' retries and `delaySeconds` replace the table.
- `webhook_events_processing_status_idx` — event and delivery are written in one batch, so nothing scans for pending events. Add it back if a later phase processes events asynchronously.
- `deliveries_automation_status_idx` — `status` changes on every transition, so this index costs a write on each one. Activity filters by automation and status within a date range, which `deliveries_created_at_idx` narrows; dashboard counts are rare.
- `deliveries_automation_commenter_idx` — enforcement moved to the once-per-user partial unique, which also serves lookups of the slot holder.
- `deliveries_comment_created_at_idx` — replaced by `created_at` (always set, never updated; retention runs on it).

## D1 rows written per comment (ADR 0002 gate 2)

Measured on local D1 (Miniflare's `meta.rows_written`); production D1 may count index maintenance differently, so check `meta.rows_written` on a deployment before relying on it. Text primary keys add one `sqlite_autoindex` write per insert.

| Comment | Statements | Rows written |
|---|---|---|
| Matched and sent | event 3 + delivery 6 + claim 3 + finish 1 | **13** |
| Skipped (any reason) | event 3 + delivery 4 | 7 |
| Meta redelivery | all `ON CONFLICT DO NOTHING` | 0 |

At 13 rows per sent comment, the 100,000 rows/day budget allows about 7,500 sent comments a day, before retries (about 4 more rows each), `app_settings` stamps and operational events. An operational event costs 4 rows locally (table, primary key, `created_at` and `related_delivery_id` indexes); the functions in `deliveries.ts` write none; deleting a delivery that events point to also updates their `related_delivery_id`.
