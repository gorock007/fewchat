# Step 2b: token envelopes, delivery processing, and queue consumer
status: done
agent: codex gpt-6-astra
brief: handoffs/briefs/2026-11-16-0951-delivery-consumer.md

## What the user asked
Build the AES-GCM token envelope, conditional delivery transitions and slot release, delivery processor, queue consumer, and D1-backed tests from the completed schema and Meta client handoffs.

## What changed
- Implemented the exact ruled token envelope using Web Crypto: HKDF-SHA256, empty salt, `fewchat/ig-token/v1` info, AES-256-GCM, fresh 96-bit IV, account-bound associated data, unpadded base64url `v1.<iv>.<ciphertext>`. `TokenEnvelopeError` has fixed messages and no underlying cause or credential material. Tests cover independent protocol decoding, round trip, randomness, wrong key/account, ciphertext/IV tampering, version, encoding and missing-input rejection.
- Added conditional `expireDelivery` and `deferDelivery`; permanent failure now clears `counts_toward_once_per_user` inside the same conditional status update. Expiry also releases the slot atomically. Tests prove a later comment can claim the released slot, existing SKIPPED comments stay skipped, UNKNOWN keeps its slot, and non-pending rows cannot be expired/deferred.
- Added `markNeedsReconnect(db, accountId, now, encryptedAccessToken)`. Its conditional update requires the stored ciphertext to match the delivery's credential snapshot (including null), so an older attempt cannot overwrite a reconnect that stored new credentials.
- Implemented `processDelivery(id, deps)` with global pause, connection-status gating, active automation/eligibility checks, atomic claim, token decryption, domain template rendering/validation, one private send, and every ruled outcome mapping. The fifth retryable rejection becomes terminal; UNKNOWN remains unknown even on attempt five. Token/permission rejection persists the retry (or final failure) before marking reconnect; decrypt failure persists permanent failure before marking reconnect. No public replies.
- Implemented the user's answer: **global `app_settings.sends_paused` plus `connectionStatus !== 'connected'` only**. No account pause field or test was added; global pause, needs_reconnect, and disconnected are tested.
- Added a UTF-8 byte check after domain validation/rendering because the existing domain length check counts characters. Missing comment timestamps fail closed as EXPIRED. Eligibility uses the domain's existing one-hour safety margin. Backoff honors Retry-After and uses the clock after the response; eligibility is rechecked on the next processing pass.
- Early queue messages defer to the persisted due time. The atomic claim also checks `next_attempt_at <= now`, closing the prerequisite handoff's early-retry caveat even when a competing caller changes backoff after the preflight read. A deterministic concurrent regression holds the second claim until the first rejection is persisted and proves exactly one request.
- Claim and delivery-result persistence exceptions propagate unchanged. A real D1 trigger rejecting the SENT result update proves exactly one HTTP request, a remaining SENDING row, later UNKNOWN quarantine, and no resend. Tests also prove late success after quarantine and one winner under concurrent successful processing.
- Added `handleDeliveryBatch(batch, deps)`: malformed ack; pre-claim failure retry; deferred retry with rounded/bounded delay; all other outcomes/errors ack. An ambiguous claim-response failure leaves its committed SENDING row for quarantine. Logs contain only delivery ID, result, and fixed error class, one JSON line per message; raw errors, credentials, provider messages and commenter content are excluded.
- Added delivery decision-table/API documentation and updated DB state-machine documentation. Worker entry-point wiring remains untouched, as required for phase 2c.
- **Review fix 1:** missing, empty, null, or whitespace-only deployment keys now raise `BeforeClaimError` before claiming or mutating pending rows. Processor regressions assert no claim, request, delivery change, or account change; the queue regression proves retry without a delay.
- **Review fix 2:** reconnect writes are best effort after the delivery status is durable. Account-write failure is caught and returned as fixed `errorClass: "AccountReconnectWriteError"`; the consumer includes it in the existing single JSON message log, with no raw exception name/message/cause. Real D1 account-write failures prove decrypt failure remains PERMANENT_FAILED and token/permission rejection remains RETRYABLE_FAILED (or PERMANENT_FAILED at the attempt cap), never stranded for SENDING quarantine. Queue tests also use sensitive synthetic exception names/messages and assert the exact safe log line.
- **Review fix 3:** ciphertext comparison protects concurrent reconnects. A test changes credentials while the private send is in flight, then returns token_invalid; the newer account stays connected and its timestamp/ciphertext remain unchanged. Another test covers a stale null credential snapshot. Added the explicit README line that a claim-time D1 error is acked and recovered by the sweep.

## Files
- src/crypto/tokens.ts — created
- src/crypto/tokens.test.ts — created
- src/delivery/process.ts — created
- src/delivery/process.worker.test.ts — created
- src/delivery/test-fixtures.ts — created (synthetic test-only helpers)
- src/delivery/README.md — created
- src/worker/consumer.ts — created
- src/worker/consumer.worker.test.ts — created
- src/db/accounts-write.ts — created
- src/db/deliveries.ts — modified (shared file)
- src/db/deliveries.worker.test.ts — modified
- src/db/README.md — modified
- handoffs/2026-11-16-0951-delivery-consumer.md — created, then updated from blocked to done (this handoff)

## Checks run
- After all three review fixes, the required check chain ran under `handoffs/bin/jarvis lock suite --reuse -- bash -o pipefail -c 'pnpm lint && pnpm typecheck && pnpm test 2>&1 | tail -15 && pnpm build >/dev/null && ! grep -rnE "console\\.(log|error)\\(.*(token|text|username)" src/delivery src/worker/consumer.ts src/crypto'`: **passed, exit 0**. Lint clean, Next/root and Worker typechecks passed, **18 test files / 444 tests passed**, production build passed, log-content scan clean. Used the configured checkout-wide `suite` lock; did not change lock configuration or test scripts. Pipefail preserves test failures through tail.
- Review regressions: `pnpm exec vitest run src/delivery/process.worker.test.ts src/worker/consumer.worker.test.ts` passed **2 files / 59 tests**, including 13 new tests for missing keys, account-write failures, ciphertext races, and safe logging.
- Initial targeted crypto/DB/processor/consumer run: 4 files, 82 tests passed. After adding atomic due-time enforcement and its regression, focused DB/processor run: 2 files, 60 tests passed. The final full suite above includes every final test.
- Targeted ESLint passed. Initial typechecking found a return-union narrowing issue and the Worker TextDecoder constructor's required `ignoreBOM` option; both corrected before the final passing checks.
- `git diff --check` on the changed source/documentation files passed. Formatted only touched TypeScript files.
- Vitest emits the existing configLoader/ESM warning; no tests were skipped in the final suite.

Not checked: browser/e2e, deployed D1/Cloudflare execution, real Meta sends or tokens, and live Phase 0 behavior. D1 tests apply migrations only to disposable local Miniflare databases and use fake Meta fetch responses. No real database migrations were applied.

## Processes left running
none

## Notes for Jarvis
- **Shared-file edit:** `src/db/deliveries.ts` only: atomic due-time guard plus returned pending due time, terminal slot release, and the two new transition helpers. Schema, migrations, package files, lockfile, config, domain, Meta adapter, Worker entry point, and ingest code were not changed.
- Phase 2c dependencies: `DeliveryDependencies` has `db`, `meta`, `tokenEncryptionKey`, `limits: { perHour, burstPerMinute }`, `now: () => epochMilliseconds`, and `random: () => number`. Consumer adds optional `log(line)`. The consumer's import pulls the processor/crypto runtime into the Worker typecheck without any tsconfig edit.
- Token callers use `encryptToken(token, { encryptionKey, instagramAccountId })` / `decryptToken(envelope, context)`; account ID means the **local database row ID**, not Meta's professional account user ID. The private-send request itself uses Meta's `instagramUserId` and the delivery's comment ID.
- `BeforeClaimError` is the queue's safe-to-retry marker and intentionally hides underlying exception details. Ambiguous claim failures and delivery-result persistence failures are acknowledged and recovered by D1/sweep. An account-reconnect write failure instead returns the already-persisted delivery outcome plus fixed `errorClass: "AccountReconnectWriteError"`; the consumer logs it, and future direct processor callers should also log that diagnostic. `rate_limited` from `claimDelivery` now also means the pending row is not due; its `retryAt` remains the scheduling contract.
- Retryable Meta outcomes are acknowledged after D1 persistence; phase 2c must enqueue due pending rows and quarantine stale SENDING rows. Pause/reconnect gates leave rows pending. This phase neither wires `queue()` nor implements the sweep.
- `permission_denied` follows this brief's explicit retry-plus-reconnect ruling, overriding the older Meta README's terminal-action suggestion. `ineligible` remains reserved in the Meta classifier; its mapping is tested with a direct synthetic typed-client outcome, not a fabricated Meta error code.
- Full-suite results include the concurrent ingest worker's completed work. Its files and handoff bookkeeping are excluded from this file list. No commits, pushes, deployment, real credentials, or external application writes were performed.
- Suggested commit message: `feat(delivery): encrypt tokens and process durable private replies with safe queue consumption`.
