# Step 2b: delivery processing — token envelope, processDelivery, queue consumer
worker: codex
model: gpt-6-astra (Opus cap full while 2a runs; also token crypto + the send path)
effort: high
started: 2026-11-16 09:50 · terminal: 65be5cc6-d9ca-4e44-8864-2faa4daf0dd0
budget: min=100

## Goal
One function, `processDelivery`, takes a delivery id from QUEUED or
RETRYABLE_FAILED to its next state with **at most one** Meta send, and a
queue handler calls it for each message. Instagram tokens are stored and read
through an AES-GCM envelope. Done = D1-backed tests with a fake Meta `fetch`
prove every outcome below (including "never sends twice"), and `pnpm lint &&
pnpm typecheck && pnpm test && pnpm build` pass. Wiring `src/worker/index.ts`
`queue()` to the handler is NOT in this phase (2c does it with the sweep).

## Context
- Spec: `docs/PRD.md` FR-05, FR-06, FR-10 (pause), §7.4–7.6, §8.3 ("External
  side-effect safety"), §10; `docs/research/meta-api.md` §6.1, §7;
  `docs/adr/0002-free-first-cloudflare.md` Decision 3 and Decision 5 (token
  envelope).
- Build on (read the handoffs, don't re-derive):
  `handoffs/merged/2026-11-16-0938-d1-schema.md` — `claimDelivery`,
  `finishDelivery`, `failDelivery`, `quarantine*` in `src/db/deliveries.ts`,
  `src/db/test-d1.ts` for D1 tests;
  `handoffs/merged/2026-11-16-0935-meta-client.md` — `createMetaClient`,
  `sendPrivateReply` and its outcome union (`src/meta/README.md` says what to
  do with each `kind`).
- Domain to call, not reimplement: `checkEligibility`, `decideSend` /
  `RateLimitOptions`, `computeBackoff`, `renderTemplate` / `validateTemplate`
  (`src/domain/`).
- Rulings already made (don't reopen):
  - **Token envelope** (`src/crypto/tokens.ts`, Web Crypto only):
    `v1.<iv>.<ciphertext>` base64url, random 96-bit IV, AES-256-GCM, key =
    HKDF-SHA256(ikm = UTF-8 `TOKEN_ENCRYPTION_KEY`, salt empty, info
    `"fewchat/ig-token/v1"`), associated data `"fewchat:ig-token:" +
    instagramAccountId`. `encryptToken` / `decryptToken`; a wrong key, wrong
    account, tampered byte or unknown version throws a typed error with no
    token or key material in it.
  - **Order in `processDelivery`** (deps injected: `db`, Meta client, key,
    limits, `now`, `random`):
    1. Load delivery + account + automation. Missing row or not pending →
       `{ result: "skipped" }`, no writes.
    2. Paused (`app_settings.sends_paused` or the account's), or account not
       `connected` → no claim, no writes, `{ result: "paused" }` (the row stays
       QUEUED; the sweep picks it up after resume, FR-10).
    3. Automation inactive/deleted, or outside the 7-day window
       (`checkEligibility` on `commentCreatedAt`) → `EXPIRED` (conditional
       from QUEUED/RETRYABLE_FAILED) **and release the once-per-user slot**.
    4. `claimDelivery`. `rate_limited` → `deferDelivery` (new: sets
       `next_attempt_at`, conditional on pending status) and
       `{ result: "deferred", retryAt }`; `unavailable` → `"skipped"`.
    5. Decrypt the token, render the DM; a render/validation failure or a
       decrypt failure → `PERMANENT_FAILED` (decrypt failure also sets the
       account `needs_reconnect`). No send.
    6. `sendPrivateReply` once. Map `kind`: `sent` → `finishDelivery` with the
       id; `unknown` → `DELIVERY_UNKNOWN` (keeps the slot); `rate_limited` and
       `not_sent` → `RETRYABLE_FAILED` with `next_attempt_at` from
       `computeBackoff` (honour `retryAfterMs`); `token_invalid` and
       `permission_denied` → `RETRYABLE_FAILED` with backoff **and** the account
       set `needs_reconnect`; `ineligible`, `policy_blocked`, `invalid_request`
       → `PERMANENT_FAILED` + release the slot. When the attempt count reaches
       the max (constant `MAX_SEND_ATTEMPTS = 5`), a retryable outcome becomes
       `PERMANENT_FAILED` + release instead.
    7. If writing the result throws after a send, do not catch-and-resend: let
       it propagate (the row stays SENDING; quarantine moves it to UNKNOWN and
       a late `finishDelivery` may still record SENT).
  - **Slot release (user ruling, 2026-11-16):** a delivery that ends
    `PERMANENT_FAILED` or `EXPIRED` frees the commenter's once-per-user slot,
    so their next comment on that automation can get a DM. Do it in the same
    conditional statement as the status change (clear
    `counts_toward_once_per_user`); `DELIVERY_UNKNOWN` and `SENT` keep it.
    Comments already SKIPPED for once-per-user stay SKIPPED (no retroactive
    send).
  - **Public replies (FR-07) are out of scope** for this phase.
  - **Queue handler** (`src/worker/consumer.ts`, `handleDeliveryBatch(batch,
    deps)`): parse `{ deliveryId }` (malformed → ack + one structured log
    line); `processDelivery`; `deferred` → `message.retry({ delaySeconds })`
    clamped to the queue maximum; any thrown error **before the claim** →
    `message.retry()`; everything else → `ack()`. Logs are one JSON line per
    message: delivery id, result, error class — never tokens, DM text,
    usernames or comment text.

## Scope
- May touch: `src/crypto/`, `src/delivery/`, `src/worker/consumer.ts`, `src/worker/consumer.worker.test.ts`, `src/db/deliveries.ts`, `src/db/deliveries.worker.test.ts`, `src/db/accounts-write.ts`, `src/db/README.md`
- Must not touch: `src/worker/index.ts`, `src/worker/app.ts`, `src/worker/harness.ts`, `src/worker/webhook.ts`, `src/ingest/`, `src/db/accounts.ts`, `src/db/automations.ts`, `src/db/schema.ts`, `migrations/`, `src/meta/`, `src/domain/`, `src/config/`, `wrangler.jsonc`, `tsconfig*.json`, `package.json`, `pnpm-lock.yaml`, `spike/`, `docs/`, `handoffs/` (except your handoff), git
- Shared files (edit minimally, name in handoff): `src/db/deliveries.ts`

## Phase
1. `src/crypto/tokens.ts` + `tokens.test.ts` (unit project): round trip;
   wrong key / wrong account / flipped byte / `v2.` prefix each throw; two
   encryptions of one token differ; error messages contain neither token nor
   key.
2. `src/db/deliveries.ts`: add `expireDelivery`, `deferDelivery`, and slot
   release inside the `PERMANENT_FAILED` path of `failDelivery` (or a
   `failPermanently`), all conditional single statements; extend
   `deliveries.worker.test.ts` (release lets a second counting delivery for
   the same user + automation insert; UNKNOWN does not release).
   `src/db/accounts-write.ts`: `markNeedsReconnect(accountId)`.
3. `src/delivery/process.ts`: `processDelivery` as ruled. Keep Workers globals
   out of `src/delivery/` (the root tsconfig type-checks it without Workers
   types — see the 1b handoff's tsconfig note); D1 types come via drizzle's
   `Db` as `src/db/deliveries.ts` does.
4. `src/delivery/process.worker.test.ts` (D1 via `src/db/test-d1.ts`, fake
   Meta `fetch` counting requests): sent; unknown (and a second
   `processDelivery` on the same id sends nothing); rate_limited → RETRYABLE
   with `next_attempt_at`; not_sent → RETRYABLE; token_invalid →
   needs_reconnect + RETRYABLE; policy_blocked → PERMANENT + slot released;
   max attempts → PERMANENT; paused (global and account) → no claim, no
   request; disconnected account → no request; expired window → EXPIRED, no
   request; inactive automation → EXPIRED; claim over the hour limit →
   deferred, no request; decrypt failure → PERMANENT + needs_reconnect, no
   request; result write throws after a sent response → error propagates,
   exactly one request, row still SENDING; two concurrent `processDelivery`
   calls on one id → exactly one request.
5. `src/worker/consumer.ts` + `consumer.worker.test.ts` with a fake
   `MessageBatch`: ack / retry / retry-with-delay / malformed message.
6. `src/delivery/README.md`: the decision table (outcome → status → slot →
   account effect), one line per row.

## Checks
```bash verify class=light timeout=600
pnpm lint && pnpm typecheck && pnpm test 2>&1 | tail -15 && pnpm build >/dev/null && ! grep -rnE 'console\.(log|error)\(.*(token|text|username)' src/delivery src/worker/consumer.ts src/crypto
```

## Questions first
Put every question in one first handoff (`status: blocked`) and stop. After
the answers arrive on your terminal, finish this phase without stopping
again. If you have no questions, build straight through.
