# Meta HTTP adapter

`createMetaClient({ fetch, baseUrl, version })` uses injected Web APIs only; no
configuration reads, database access or business rules. Pass the Graph origin
(e.g. `https://graph.instagram.com`) and the caller's pinned version. The code
exchange alone uses Meta's fixed `https://api.instagram.com/oauth/access_token`;
long-token exchange/refresh use unversioned paths on the configured Graph origin.
All resource paths are versioned. Construction rejects invalid or non-HTTPS Graph
origins. Every request uses `redirect: "manual"`; 3xx responses return an
`unknown` failure without following Location. This module never logs requests or
responses.

The client exposes `exchangeCode`, `exchangeLongLived`, `refreshToken`,
`getAccount`, `getMedia`, `getComment`, `getComments`, `subscribeAccount`,
`sendPrivateReply` and `sendPublicReply`. Reads return `{ kind: "ok", data }` or
a failure. Token responses preserve the returned `expires_in`; short-token
`user_id` is app-scoped and must not replace the professional account's
`getAccount().data.user_id`. Optional media/comment fields may be absent; the
consumer must hydrate required eligibility facts. IDs are never coerced to numbers.

`getMedia` and `getComments` fetch one page, accepting `{ after, limit }`. Returned
`cursors.after` is present only when Meta supplies a next-page indication. Pass
that cursor to another bounded call; provider `next` URLs are neither followed
nor returned. The consumer owns pagination limits.

All methods accept `{ signal, timeoutMs }` (default 30 seconds, covering response
body consumption and both read attempts). Account/media/comment reads retry once
on 5xx or transport loss; a caller abort/timeout stops immediately. Sends, token
exchanges/refreshes and subscription writes never retry. A failure during request
construction or an already-aborted signal yields `not_sent`; once injected fetch
is called, transport loss or timeout yields `unknown`, even if fetch throws
synchronously. This conservative boundary cannot prove that the provider saw
bytes on the wire.

Response bodies are capped at 1 MiB of streamed bytes, independent of
Content-Length, before JSON parsing. Overflow cancels the stream and returns an
`unknown` failure with the observed HTTP status, without retrying reads or sends.
Empty access tokens, comment IDs and message text fail during request construction
with `not_sent`. Malformed OAuth codes also return `not_sent` through the guarded
request path.

## Delivery consumer contract

`SendOutcome` is discriminated by `kind`. Private success has
`{ kind: "sent", ids: { recipient_id, message_id } }`; public success has
`{ kind: "sent", ids: { id } }`. Both private IDs are mandatory, nonempty strings.
Every failure carries `{ httpStatus, code, subcode, type, isTransient, fbtraceId,
message }`, using `null` for unavailable fields. Diagnostics are credential
redacted and bounded to 300 characters. The client supplies request credentials
to the classifiers; direct classifier users must supply `secrets` for redacting
bare or URL-encoded credentials in arbitrary prose. Structured access-token,
client-secret and Bearer values are additionally redacted by pattern.

| Outcome | Consumer (2b) action |
| --- | --- |
| `sent` | Persist accepted IDs; only then consider the public leg; acceptance is not inbox visibility. |
| `rate_limited` | Reschedule with account backoff and recheck eligibility; honor optional `retryAfterMs` (seconds or HTTP-date header). |
| `token_invalid` | Pause account sends and request reconnection; no retry with the same token. |
| `permission_denied` | Record a terminal authorization/configuration failure and surface the missing permission. |
| `ineligible` | Terminal eligibility rejection; reserved for future verified mappings, currently never emitted. |
| `policy_blocked` | Stop and surface the policy restriction; no ordinary rate-limit retry. |
| `invalid_request` | Record terminal malformed-input failure; fix input before any new attempt. |
| `unknown` | Quarantine as `DELIVERY_UNKNOWN`, retain reservations, and never automatically resend. |
| `not_sent` | No fetch was dispatched; fix construction/configuration or cancellation and let scheduling policy decide a safe retry. |

Error-shaped responses below HTTP 400 are always `unknown`, even when the body
contains a known rejection code: a 2xx does not prove a send was rejected.
5xx and generic codes 1/2 stay `unknown`, including when a throttle signal is
also present. HTTP 429 and codes 4/17/613/80002 otherwise mean explicit throttling.
Code 190 means invalid token; 10/200–299 permission failure; 368 policy block;
code 100 without a subcode invalid input. Unmapped tuples stay `unknown`.
No classification matches English error wording or infers success from an error.

**UNVERIFIED pending the user's real Phase 0 test:** `10900`, `10903` and subcode
`2534025` always remain `unknown`, preserving the tuple. There is no verified
Instagram-specific duplicate/expired/ineligible classifier yet. Generic code
meanings do not prove which exact tuples this integration will emit. Graph
version support, real webhook envelope/signing secret, access level and actual
non-tester/non-follower delivery also remain live-test gates.

Seven-day deadlines, the expanded 1,000-byte message limit, atomic claims,
reservations and successful-result persistence belong to the consumer/domain.
Adapter tests feed the parsed comment timestamp into the existing domain policy
at a fixed seven-day boundary. Persistence-failure tests belong to 2b. If saving
a successful API result fails, the consumer must
quarantine the claimed job rather than call this client again; only integration
tests of that durable persistence path can prove the quarantine behavior.

## Webhooks and fixtures

`verifySubscription(URLSearchParams, verifyToken)` returns the unchanged challenge
or `null`. `readSignedBody(request, appSecret, { maxBytes: 32768 })` returns
`{ ok: true, body: Uint8Array }` or `{ ok: false, reason }`, where reason is
`missing_signature`, `bad_signature` or `too_large`. It validates the exact
`sha256=` plus 64-hex header, caps actual streaming bytes independently of
Content-Length, cancels oversized streams and verifies via Web Crypto HMAC.
No JSON parsing happens here. The route must parse and durably persist only after
verification; verification itself does not authorize an HTTP 200 acknowledgement.

`fixtures.ts` contains only synthetic fact-sheet values and `signFakeBody` with an
explicitly fake test secret. Use it for unit tests and fake replays, never as the
application signing secret. The tests inject fetch and never call the network.
