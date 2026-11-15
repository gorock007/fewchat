# FewChat
## Meta API Fact Sheet

**Verified:** November 15, 2026  
**Integration:** Instagram API with Instagram Login  
**Status:** Documentation verified; no real-account requests or credentials used.

Facts below cite official Meta documentation retrieved on the verification date. Some web fetches returned 429; those pages were read directly from Meta using its Markdown representation or rendered HTML text. Repository evidence is explicitly distinguished from Meta guarantees. **UNVERIFIED — needs live test (Phase 0)** means implementation must preserve the uncertainty rather than invent a successful outcome. FewChat-specific policies are identified as such and derive from [PRD §§6–10, 17, 21](../PRD.md), file `docs/PRD.md` at commit `286e2879fa2c2a97b9dab392048a545d6fcff416`.

---

# 1. Integration and Version

Use professional Business or Creator accounts. Instagram Login does not require a linked Facebook Page. Resource calls use `https://graph.instagram.com`; token exchange has separate endpoints below. [Instagram Login overview][login-overview]

**Pin resource calls centrally to `v27.0`.** Meta's versioning guide identifies it as latest, and the current Instagram getting-started examples use `graph.instagram.com/v27.0`. However, the versions table retrieved on the same date stops at `v26.0` (July 29, 2026). Do not invent a v27 release/retirement date from that table. **UNVERIFIED — needs live test (Phase 0):** confirm v27 works for the actual app's profile, media, subscription and private-reply calls. Record the successful version before release; never silently downgrade or make unversioned resource calls. [Versioning][versioning], [Instagram get started][get-started], [versions table][versions]

Meta now recommends Unified Login for new integrations. Its migration guide says existing Instagram Login integrations continue working and gives no end date. This audit retains the PRD's Instagram Login choice. Unified Login is a different integration using `graph.facebook.com`, different tokens and `instagram_*` permissions, including a messages permission for private replies. Do not mix those requirements into Instagram Login. **UNVERIFIED — needs live test (Phase 0):** availability of the selected Instagram Login setup for this newly configured Meta app. If unavailable, Jarvis must explicitly revisit the integration choice. [Migration guide][migration], [Private Replies][private]

---

# 2. OAuth and Tokens

## 2.1 Endpoints

| Step | Method and exact endpoint | Parameters |
|---|---|---|
| Authorization | `GET https://www.instagram.com/oauth/authorize` | `client_id` = Instagram App ID; `redirect_uri`; `response_type=code`; `scope`; `state` |
| Code → short token | `POST https://api.instagram.com/oauth/access_token` | Form fields `client_id`, `client_secret` = Instagram App Secret, `grant_type=authorization_code`, same `redirect_uri`, `code` |
| Short → long token | `GET https://graph.instagram.com/access_token` | `grant_type=ig_exchange_token`, `client_secret`, `access_token` |
| Refresh long token | `GET https://graph.instagram.com/refresh_access_token` | `grant_type=ig_refresh_token`, `access_token` |

These token endpoints are **unversioned**. Authorization codes are single-use and valid for one hour; remove the redirect's `#_` fragment if present. `enable_fb_login=false` and `force_reauth=true` are optional authorization parameters. [Business Login][login]

## 2.2 Lifetimes and storage

- Short-lived Instagram User token: **one hour**, according to current access-token reference and getting-started guide. Do not copy older 24-hour assumptions. [Access Token][access-token], [get started][get-started]
- Long-lived token: **60 days**. Refresh only when at least **24 hours old** and still valid, with `instagram_business_basic` granted; refresh extends it for another 60 days. An expired token cannot be refreshed. Persist the returned token and actual `expires_in`. [Business Login][login]
- FewChat policy: encrypted tokens, server-only exchange, daily expiry checks with early refresh, safe reconnect on lost authorization. Bind random, expiring OAuth state to the initiating admin session, consume it once, and require exact redirect matching. Do not log credential-bearing token URLs. [PRD FR-01, §§10.3, 11](../PRD.md); reference implementation: [AutoDM `oauth.ts` at e32f451][auto-oauth].

## 2.3 Token response fixtures

Synthetic values only. Meta documents a short-token `data` array with a permissions string; tolerate a validated flat variant for compatibility (AutoDM explicitly handles both). Do not assume the token response's app-scoped ID is the professional account ID. [Business Login][login], [get started][get-started], [AutoDM `oauth.ts` at e32f451][auto-oauth]

```json
{
  "data": [
    {
      "access_token": "FAKE_SHORT_TOKEN_NOT_VALID",
      "user_id": "90000000000000001",
      "permissions": "instagram_business_basic,instagram_business_manage_comments"
    }
  ]
}
```

```json
{
  "access_token": "FAKE_LONG_TOKEN_NOT_VALID",
  "token_type": "bearer",
  "expires_in": 5184000
}
```

The second fixture is suitable for exchange/refresh parsing; `5184000` is synthetic, not a promise of the exact returned duration. [Business Login][login]

---

# 3. Required Permissions

## 3.1 Minimal permission set

| Capability | Instagram Login scopes | Source |
|---|---|---|
| Account/profile and owned media | `instagram_business_basic` | [Permission reference][basic-permission], [get started][get-started] |
| `comments` webhook | `instagram_business_basic`, `instagram_business_manage_comments` | [Webhook field matrix][fields] |
| Read comments and commenter fields | `instagram_business_basic`, `instagram_business_manage_comments` | [Comment Moderation][moderation], [IG Comment][comment] |
| One private reply addressed by comment ID | `instagram_business_basic`, `instagram_business_manage_comments` | [Private Replies, Instagram Login column][private] |
| Public comment reply | `instagram_business_basic`, `instagram_business_manage_comments` | [Comment Moderation, Instagram Login column][moderation] |

**Resolution of PRD §7.2:** do **not** request `instagram_business_manage_messages` for this MVP's comment-addressed private reply. It is absent from the Instagram Login requirements for that operation. Generic inbox messaging/postbacks use that scope; FewChat does neither. This documentation decision still needs the exact two-scope live test before production. [Private Replies][private], [messaging guide][messaging], [webhook fields][fields]

Use the full `instagram_business_*` names. Old `business_*` scope names were deprecated January 27, 2025. Do not request publishing, insights, ads, Pages or Human Agent permissions for the MVP. [Instagram Login overview][login-overview]; FewChat scope: [PRD §§3, 7.2](../PRD.md).

---

# 4. Account, Media and Comment Reads

Resolve `GET /v27.0/me?fields=user_id,username,account_type` with the Instagram User token. Store `user_id` as the professional account ID used in `entry.id` and send paths. `id` is app-scoped; do not substitute it silently. Owned media are available through `GET /v27.0/{ig_user_id}/media`. [Get started][get-started]

Select supported display fields such as `id,caption,media_type,media_product_type,thumbnail_url,permalink,timestamp`; tolerate missing optional fields. Request `GET /v27.0/{media_id}/comments?fields=id,text,from,timestamp,parent_id,media` for reconciliation and `GET /v27.0/{comment_id}?fields=id,text,from,timestamp,parent_id,media` for enrichment. `timestamp` is comment creation time; `parent_id` identifies a reply. Restricted or age-gated comments can be absent. [Media reference][media], [comments edge][comments-edge], [IG Comment][comment]

FewChat policy: page through bounded requests; validate timestamps; stop sends at seven days; reject nested/self/foreign-media comments; converge webhook and polling through the same durable deduplication path. Preserve IDs as exact strings. Do not send if required eligibility facts cannot be established. Reconstruct cursor requests on the configured host rather than blindly trusting arbitrary next URLs. [PRD FR-04, FR-06, FR-11, §§7, 10](../PRD.md)

Synthetic comment-read fixture; a nested-comment test adds `"parent_id": "90000000000000005"`. The timestamp is intentionally separate from webhook notification time. [IG Comment][comment]

```json
{
  "id": "90000000000000003",
  "text": "GUIDE please",
  "from": { "id": "90000000000000004", "username": "fake_commenter_example" },
  "media": { "id": "90000000000000002", "media_product_type": "REELS" },
  "timestamp": "2026-11-15T00:00:00+0000"
}
```

---

# 5. Webhooks

## 5.1 Configuration and account subscription

Configure the HTTPS callback `/api/webhooks/instagram`, a separate verify token and the `comments` field in the App Dashboard, then enable that field for the connected account:

```http
POST https://graph.instagram.com/v27.0/90000000000000001/subscribed_apps?subscribed_fields=comments&access_token=FAKE_TOKEN_NOT_VALID
```

Expected response: `{"success":true}`. `/me` may represent the token's professional account. Record subscription failure independently from successful token storage. The shown token is fake; redact query strings in diagnostics. [Webhook setup][setup]; persistence policy: [PRD FR-01, §7.3](../PRD.md).

## 5.2 Verification and signature

GET receives `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`; validate mode/token and return the unchanged challenge as plain text with 200. POST carries `X-Hub-Signature-256: sha256=<hex>`, computed using the app secret and payload. [Webhook setup][setup]

FewChat implementation contract: calculate HMAC-SHA256 over the **original body bytes**, validate exactly 64 hexadecimal digest characters, length-check decoded buffers, then compare using `timingSafeEqual` **before** parsing. Use the secret belonging to this Instagram Login app configuration, not the verify token. Verify the selected signing secret with a real delivery; do not copy OpenReply's accept-either-secret fallback. Missing/invalid signatures fail closed. [PRD §7.3](../PRD.md), [AutoDM `verifySignature` at e32f451][auto-webhook], [OpenReply `verifyWebhookSignature` at c78b2d2][open-webhook]

Persist minimal normalized event fields and job intent transactionally before 200. A storage failure returns an unsuccessful response. Generate fixture signatures from the exact serialized fake body and a test-only fake secret; whitespace changes must invalidate the original signature. [PRD §7.3](../PRD.md)

## 5.3 Payload shape and omissions

The account ID is `entry[].id`; `entry[].time` is **notification send time**, not comment creation time. Instagram Login comment values expose `id`, `from.id`, `from.username`, `text`, `media.id` and `media.media_product_type`. [Webhook examples][examples], [webhook setup][setup]

The canonical implementation fixture below combines the generic `changes[]` envelope with Instagram Login comment fields. **UNVERIFIED — needs live test (Phase 0):** the exact envelope and optional fields from the configured app. Meta's current Instagram Login example omits `changes[]`, has JSON presentation defects, and calls `value` an array although its sample uses an object. Both audited implementations parse `entry[].changes[].value`. Do not present this repaired fixture as a captured Meta event. [Webhook examples][examples], [AutoDM parser at e32f451][auto-webhook], [OpenReply parser at c78b2d2][open-webhook]

```json
{
  "object": "instagram",
  "entry": [
    {
      "id": "90000000000000001",
      "time": 1794700801,
      "changes": [
        {
          "field": "comments",
          "value": {
            "id": "90000000000000003",
            "from": {
              "id": "90000000000000004",
              "username": "fake_commenter_example"
            },
            "text": "GUIDE please",
            "media": {
              "id": "90000000000000002",
              "media_product_type": "REELS"
            }
          }
        }
      ]
    }
  ]
}
```

`parent_id` is documented on the Comment node and the Facebook Login webhook example; the Instagram Login example does not promise it. **UNVERIFIED — needs live test (Phase 0):** whether a nested Instagram Login comment always includes it. Treat a supplied parent as nested; when absent, query the comment node before deciding it is top-level. Likewise, hydrate missing media/author/creation time or leave the event unsent. Missing username can use a generic greeting. [IG Comment][comment], [Comment Moderation][moderation]; conservative handling: [PRD FR-04](../PRD.md).

Additional synthetic fixture variants should cover duplicate/multi-entry batches, absent username/text/media, nested `parent_id`, wrong object/account, own comment, unsupported field, altered-byte signatures and malformed JSON. These are FewChat parser/eligibility tests, not claims that Meta emits every variant. [PRD §17](../PRD.md)

---

# 6. Private and Public Replies

## 6.1 Private reply contract

```http
POST https://graph.instagram.com/v27.0/90000000000000001/messages
Authorization: Bearer FAKE_TOKEN_NOT_VALID
Content-Type: application/json
```

```json
{
  "recipient": { "comment_id": "90000000000000003" },
  "message": { "text": "Here is your guide: https://example.com/resource" }
}
```

Synthetic successful response:

```json
{
  "recipient_id": "90000000000000004",
  "message_id": "FAKE_MESSAGE_ID_001"
}
```

Address the first private reply by **comment ID**, not commenter ID. Meta returns recipient and message identifiers. One private reply is allowed for the comment within seven days of creation on a post/Reel; a non-follower's reply goes to Requests. Follow-ups require a recipient response and have separate messaging constraints; FewChat sends none. [Private Replies][private]; product restriction: [PRD FR-05](../PRD.md).

The messaging guide specifies **1,000 UTF-8 bytes**, not 1,000 JavaScript characters, for message text. Enforce the byte limit after template/URL expansion and reject oversized content without truncating the resource link. This is FewChat's conservative application of the Send API text constraint to private replies. [Messaging guide][messaging]

Store accepted response identifiers; `SENT` means API acceptance, not a read receipt or proof of inbox visibility. Missing/invalid success IDs, timeout after dispatch, connection loss, malformed response or crash before result persistence produce `DELIVERY_UNKNOWN`; do not automatically resend. [PRD FR-08, §§8.3, 10.4](../PRD.md)

## 6.2 Public reply contract

```http
POST https://graph.instagram.com/v27.0/90000000000000003/replies
Authorization: Bearer FAKE_TOKEN_NOT_VALID
Content-Type: application/json
```

```json
{ "message": "Sent it! Check your DMs or Message Requests." }
```

```json
{ "id": "90000000000000006" }
```

Meta accepts `message` and returns the new comment ID. Use the Instagram Login permission table in Comment Moderation; the older replies reference still shows Facebook/Page permissions. FewChat sends this only after private-reply acceptance, with separate claim/result state and no DM resend when the public leg fails. [Comment Moderation][moderation], [replies reference][replies]; ordering: [PRD FR-07](../PRD.md).

---

# 7. Rate Limits and Error Classification

## 7.1 Limits

Meta documents **750 private-reply calls/hour/professional Instagram account** for posts/Reels. Do not substitute generic Send API calls-per-second limits. Its rate guide documents app/user/custom throttling and usage headers, including `X-App-Usage` and `X-Business-Use-Case-Usage`. Do not assume every response includes every header. [Rate limits][rate]

FewChat policy: shared atomic reservations, **600 calls per rolling hour**, plus a short-burst cap. Honor `Retry-After` when present, use bounded exponential backoff with jitter, and recheck the seven-day deadline before dispatch. Reserve conservatively for attempted calls; uncertain sends must retain their reservation. Do not copy a fixed TTL counter or retry exhausted messages blindly. [PRD §7.6](../PRD.md), [ADR audit of OpenReply limiter](../adr/0001-build-vs-fork.md)

## 7.2 Verified meaning versus endpoint-specific uncertainty

Capture HTTP status, endpoint, `code`, optional `error_subcode`, `type`, `is_transient` and `fbtrace_id`, with sanitized bounded diagnostic text. A code's generic Graph meaning does not prove the exact tuple returned by Instagram Login private replies. [Graph error handling][graph-errors]

| Category | Evidence and code meaning | FewChat behavior |
|---|---|---|
| Rate limited | `4` = app calls, `17` = user calls; `613` = custom throttling; `80002` = Instagram BUC rate limit. HTTP 429 can also indicate throttling, but preserve body details. [Graph errors][graph-errors], [rate guide][rate] | Explicit throttling rejection → reschedule with account backoff while eligible. A response whose send outcome cannot be established stays unknown. |
| Invalid/revoked/expired token | `190`; Graph guide lists `463` expired and `467` invalid-token subcodes. Exact subcode appearance on this integration remains a live observation. [Graph errors][graph-errors] | Pause account sends and request reconnection; do not loop retries with the same token. |
| Missing permission | `10`, `200` and related `200–299` Graph permission errors. [Graph errors][graph-errors] | Permanent delivery failure; surface required authorization/configuration change. |
| Already replied | Meta's **Page Messages** reference defines `10900` as already replied. It does **not** establish that Instagram Login will return it. **UNVERIFIED — needs live test (Phase 0).** [Page Messages][page-messages] | If verified for this endpoint, mark handled and do not resend; do not invent a message ID or claim FewChat sent it. |
| Outside seven-day window | Deadline is documented, but no unique Instagram Login private-reply expiry tuple was found in the reviewed official pages. `10903` in Page Messages means cannot reply, not specifically expired. **UNVERIFIED — needs live test (Phase 0).** [Private Replies][private], [Page Messages][page-messages] | Enforce `comment_created_at + 7 days` locally. A confirmed eligibility rejection is terminal; unknown eligibility must not become a transient retry. |
| Comment ineligible | OpenReply preserves subcode `2534025` and describes it as ineligible for private reply. This is **upstream evidence only**, not verified Meta documentation; it does not distinguish duplicate from expiry. **UNVERIFIED — needs live test (Phase 0).** [OpenReply `lib/meta/client.ts` at c78b2d2][open-client], [`__tests__/meta-errors.test.ts`][open-error-tests] | Do not label all such errors “already sent” or “expired.” Hold unknown mappings for review; never automatically retry an ineligible private reply. |
| Policy/abuse block | `368` is a policy block in Graph guidance, not a synonym for the hourly rate limit. [Graph errors][graph-errors] | Stop/surface policy restriction; no ordinary rate-limit retry loop. |
| Invalid parameter | `100` is generic invalid parameter in Page Messages; it is not inherently missing permission or an elapsed window. [Page Messages][page-messages] | Keep subcode/context. Treat confirmed malformed input as terminal; never guess success. |
| Ambiguous send | Generic code `1`/`2`, 5xx, malformed success or transport loss after dispatch does not establish no side effect. OpenReply explicitly models this uncertainty; generic Graph retry advice alone is insufficient for sends. [Graph errors][graph-errors], [OpenReply delivery errors at c78b2d2][open-errors] | `DELIVERY_UNKNOWN`, no automatic retry. Safe read retries and known pre-dispatch failures are separate cases. [PRD §§8.3, 10](../PRD.md) |

Do not build production logic by matching English error prose. Preserve unknown tuples and add classifiers only with supporting endpoint evidence. In particular, do not transplant `10900`/`10903` from Facebook Page Messages as guaranteed Instagram Login responses. This is a deliberate implementation constraint from the evidence gaps above.

## 7.3 Synthetic error fixtures

These JSON values exercise parsing/categories; they are not live captures. Error wording is invented, and Graph error-envelope fields are based on [Meta's error guide][graph-errors]. Code meanings follow the preceding table. The final two cases deliberately exercise **unverified** mappings; neither should cause a resend.

```json
{
  "rateLimited": {
    "error": { "message": "Synthetic request limit reached", "type": "OAuthException", "code": 4, "fbtrace_id": "FAKE_TRACE_RATE" }
  },
  "invalidToken": {
    "error": { "message": "Synthetic token expired", "type": "OAuthException", "code": 190, "error_subcode": 463, "fbtrace_id": "FAKE_TRACE_TOKEN" }
  },
  "missingPermission": {
    "error": { "message": "Synthetic permission missing", "type": "OAuthException", "code": 10, "fbtrace_id": "FAKE_TRACE_PERMISSION" }
  },
  "policyBlocked": {
    "error": { "message": "Synthetic policy restriction", "type": "OAuthException", "code": 368, "fbtrace_id": "FAKE_TRACE_POLICY" }
  },
  "ambiguousSend": {
    "error": { "message": "Synthetic unknown provider outcome", "type": "OAuthException", "code": 1, "fbtrace_id": "FAKE_TRACE_UNKNOWN" }
  },
  "unverifiedAlreadyReplied": {
    "error": { "message": "Synthetic already replied", "type": "OAuthException", "code": 10900, "fbtrace_id": "FAKE_TRACE_DUPLICATE" }
  },
  "unverifiedIneligible": {
    "error": { "message": "Synthetic private reply ineligible", "type": "OAuthException", "code": 100, "error_subcode": 2534025, "fbtrace_id": "FAKE_TRACE_INELIGIBLE" }
  }
}
```

Test window expiration using the comment timestamp and a fixed clock, not a fabricated Meta expiry code. Also test non-JSON 5xx, 200 with missing IDs, network abort after dispatch and failure to save a successful result. [PRD §§8.3, 10, 17](../PRD.md)

---

# 8. Standard Access, Advanced Access and App Review

Meta's App Review scenario table says an app solely for a business the developer owns/manages can use Standard Access without App Review; serving other businesses needs Advanced Access and review. “App user” here is the connected professional account, not every commenter. [App Review][review]

**The webhook requirements are stricter:** current setup docs say the app must be Live, identify Advanced Access for Instagram Login, require it for `comments`/`live_comments`, and list business verification for production access. The older webhook guide also says Business apps without Advanced Access do not receive notifications. This is an unresolved official-documentation conflict for own-account self-hosting, not merely outdated wording in one old page. [Current webhook setup][setup], [older Instagram webhook guide][old-webhooks]

**UNVERIFIED — needs live test (Phase 0):** Standard Access alone delivering comments from non-testers/non-followers on the developer's own account. Do not advertise “no App Review required” for the complete webhook-to-DM product. Prepare for Advanced Access to the two scopes, business verification and Live mode if the actual setup requires them; App Review needs permission-specific use-case instructions and an end-to-end screencast. [App Review][review], [webhook setup][setup]

## 8.1 Required Phase 0 evidence

Jarvis/user must operate their controlled real accounts; this audit did not handle credentials or personal commenter data. These checks implement [PRD §7.7 and Phase 0](../PRD.md):

1. Record app setup, mode, Graph version, permission access levels and the **granted** two-scope set without publishing secrets or personal IDs.
2. Confirm login/exchange/profile/media calls and the connected professional account ID. Confirm `comments` subscription and a valid signed callback.
3. On a real post/Reel, test an accepted tester, an account with no app role, and a non-follower with no app role. For each, establish webhook arrival, comment/author/media IDs, successful private reply and actual inbox/Requests visibility separately.
4. Test a nested comment and missing optional fields; establish parent/creation-time hydration. Capture only privately retained sanitized evidence. Public fixtures stay synthetic.
5. Check duplicate private reply, an intentionally old controlled comment, revoked token and missing permission. Record endpoint-specific code/subcode pairs; do not deliberately generate spam or overload Meta to force a rate limit.
6. If Standard Access fails public events, document the exact dashboard/API restriction and complete the required review/access steps. Polling is a recovery mechanism, not a claimed workaround for missing platform access.

**Release gate:** all non-tester/non-follower outcomes and two-scope operation remain unproven until this evidence exists. Mocked API responses and signed synthetic webhook replays cannot satisfy it. [PRD §20](../PRD.md)

[login-overview]: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login
[login]: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
[access-token]: https://developers.facebook.com/documentation/instagram-platform/reference/access_token
[get-started]: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started
[basic-permission]: https://developers.facebook.com/docs/permissions/reference/instagram_business_basic
[private]: https://developers.facebook.com/documentation/instagram-platform/private-replies
[messaging]: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
[moderation]: https://developers.facebook.com/documentation/instagram-platform/comment-moderation
[comment]: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment
[comments-edge]: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments
[media]: https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media
[replies]: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment/replies
[fields]: https://developers.facebook.com/documentation/instagram-platform/webhooks/fields
[setup]: https://developers.facebook.com/documentation/instagram-platform/webhooks/setup
[examples]: https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
[review]: https://developers.facebook.com/documentation/instagram-platform/app-review
[old-webhooks]: https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram
[versioning]: https://developers.facebook.com/docs/graph-api/guides/versioning
[versions]: https://developers.facebook.com/docs/graph-api/changelog/versions/
[rate]: https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
[graph-errors]: https://developers.facebook.com/docs/graph-api/guides/error-handling/
[page-messages]: https://developers.facebook.com/docs/graph-api/reference/page/messages
[migration]: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide
[auto-oauth]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/oauth.ts
[auto-webhook]: https://github.com/ilramdhan/auto-dm/blob/e32f451c58f02d95f45f1215e97db2f0292b833d/src/server/instagram/webhook.ts
[open-webhook]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/meta/webhook.ts
[open-client]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/meta/client.ts
[open-error-tests]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/__tests__/meta-errors.test.ts
[open-errors]: https://github.com/diwenne/openreply/blob/c78b2d2f68c9764ef7a7dde51dfa5bfa99304a09/lib/instagram/delivery-errors.ts
