# Delivery processing

`processDelivery(deliveryId, deps)` takes `db`, `meta` (the Meta client's private-send method), `tokenEncryptionKey`, `limits: { perHour, burstPerMinute }`, `now: () => epochMilliseconds`, and `random: () => number`. It loads the delivery/account/automation and global settings, checks pause and eligibility, claims atomically, then decrypts, validates/renders, sends at most once, and persists the result. It does not send public replies. Worker entry-point wiring and the cron sweep belong to phase 2c.

| Condition / outcome | Delivery status | Once-per-user slot | Account effect |
| --- | --- | --- | --- |
| Missing row or not pending | Unchanged (`skipped`) | Unchanged | None |
| Global pause | Pending, unchanged (`paused`) | Retained | None |
| Account `needs_reconnect` / `disconnected` | Pending, unchanged (`paused`) | Retained | None |
| Missing / empty deployment encryption key | Pending, unchanged (`BeforeClaimError`) | Retained | None |
| Inactive / deleted automation | `EXPIRED` | Released atomically | None |
| Missing timestamp / expired comment window | `EXPIRED` | Released atomically | None |
| Future `next_attempt_at` | Pending, unchanged (`deferred`) | Retained | None |
| Claim refused by rolling-hour / burst limit | Pending, due time deferred | Retained | None |
| Claim lost to another caller | Unchanged (`skipped`) | Unchanged | None |
| Token decrypt failure | `PERMANENT_FAILED` | Released atomically | `needs_reconnect` |
| Template render / validation failure (including expanded UTF-8 byte limit) | `PERMANENT_FAILED` | Released atomically | None |
| `sent` | `SENT`, both returned IDs persisted | Retained | None |
| `unknown` | `DELIVERY_UNKNOWN` | Retained | None |
| `rate_limited` | `RETRYABLE_FAILED`, jittered backoff honoring `retryAfterMs` | Retained | None |
| `not_sent` | `RETRYABLE_FAILED`, jittered backoff | Retained | None |
| `token_invalid` | `RETRYABLE_FAILED`, jittered backoff | Retained | `needs_reconnect` |
| `permission_denied` | `RETRYABLE_FAILED`, jittered backoff | Retained | `needs_reconnect` |
| `ineligible` | `PERMANENT_FAILED` | Released atomically | None |
| `policy_blocked` | `PERMANENT_FAILED` | Released atomically | None |
| `invalid_request` | `PERMANENT_FAILED` | Released atomically | None |
| Retryable outcome on attempt 5 (`MAX_SEND_ATTEMPTS`) | `PERMANENT_FAILED` | Released atomically | Reconnect if token/permission failure |
| Result persistence throws after send | Error propagates; normally remains `SENDING` until quarantine | Retained | None |
| Reconnect account write throws | Already persisted `PERMANENT_FAILED` / `RETRYABLE_FAILED` remains | Follows persisted outcome | Failure reported as fixed `AccountReconnectWriteError` |

Global pause is the only pause flag (FR-10 ruling); account connection status is a separate gate. Pause returns before eligibility changes, so queued rows survive until resume. Eligibility uses the domain helper's existing one-hour safety margin before the seven-day deadline. Backoff uses the response-time clock; if it extends beyond eligibility, the next processing pass expires the row before claiming. Early queue messages respect the persisted due time, including inside the atomic claim if another caller changes it after the preflight read. A missing settings singleton is a pre-claim error, never permission to send.

`SENT` means API acceptance, not inbox visibility. `DELIVERY_UNKNOWN` is never claimed again, including on queue duplicates. A late sender may finish a quarantined claim as `SENT`. Claim/result persistence exceptions are not converted into resend attempts: even a failed claim response could hide a committed `SENDING` update. Permanent failure/expiry slot release does not revive earlier `SKIPPED` comments.

The delivery outcome is persisted before marking reconnect. Account-write failure is caught and returned as the fixed `errorClass: "AccountReconnectWriteError"`, which the queue includes in its single message log; direct callers should log this diagnostic without raw exceptions. It cannot strand a decrypt failure in `SENDING`. Reconnect writes compare the stored ciphertext with the delivery's snapshot, so a newer OAuth reconnect is never overwritten. Missing, empty or whitespace-only deployment keys throw `BeforeClaimError` before any pending-row mutation or claim.

## Queue adapter

`handleDeliveryBatch(batch, deps)` accepts the processing dependencies plus an optional `log(line)` sink (default: console). Bodies must be objects containing a nonempty delivery ID of at most 128 ASCII letters/digits/underscores/hyphens. Each message produces one JSON line with only `deliveryId`, `result`, and a fixed `errorClass`; raw bodies, exceptions, provider prose, credentials, templates, usernames and comment text are never logged.

- Malformed body: ack, log `InvalidMessage` with null delivery ID.
- `deferred`: retry with rounded-up delay in seconds, clamped to 0–86,400 ([Cloudflare Queues limit](https://developers.cloudflare.com/queues/platform/limits/)).
- `BeforeClaimError`: retry without an explicit delay. This also covers a failed deferral write after a definitive rate-limit refusal.
- Any exception during/after an attempted claim: ack; D1/sweep recovers pending rows or quarantines stale `SENDING`.
- A claim-time D1 error is acked and recovered by the sweep, since the failed response may hide a committed claim.
- Every other result, including a durably scheduled retryable rejection: ack. The sweep handles `next_attempt_at`.

No queue handler is wired in this phase. Tests run the real processor against local Miniflare D1 and a synthetic Meta fetch. Persistence failure tests verify that a successful HTTP send followed by a failed database update does not send again; local tests do not prove deployed D1 or live Meta behavior.

## Token envelope

`encryptToken(token, { encryptionKey, instagramAccountId })` and `decryptToken(envelope, context)` in `src/crypto/tokens.ts` use Web Crypto only. `instagramAccountId` is the local account row's ID. The format is unpadded base64url `v1.<12-byte IV>.<ciphertext with 128-bit tag>`, AES-256-GCM, a fresh random IV per encryption, HKDF-SHA256 with UTF-8 key material, empty salt, info `fewchat/ig-token/v1`, and associated data `fewchat:ig-token:` plus the local account ID. There is no plaintext fallback. Invalid versions, context, encoding or authentication throw `TokenEnvelopeError` with a fixed message and no underlying cause/credential material.
