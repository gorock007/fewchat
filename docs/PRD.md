# FewChat
## Product Requirements Document

**Tagline:** Less automation. Just what you need.

**Description:** A lightweight, open-source Instagram comment-to-DM automation tool.

**Version:** 1.0  
**Status:** Ready for implementation  
**Date:** November 15, 2026  
**License:** MIT  
**Initial deployment:** Single-user, self-hosted  
**Repository name:** `fewchat`

---

# 1. Product Overview

FewChat is a lightweight, open-source tool that automatically sends Instagram direct messages when someone comments on a creator's post or Reel.

The creator connects their Instagram account, selects a post, defines a comment trigger, and provides a resource URL.

When someone comments and matches the trigger, FewChat automatically sends the resource to their Instagram DMs using Meta's official API.

### Example

A creator posts an Instagram Reel explaining how to build an AI agent.

At the end of the Reel, they say:

"Comment JARVIS and I'll send you the GitHub repository."

Someone comments `JARVIS`.

FewChat receives the comment event, matches the keyword, and sends:

"Hey! Here's the Jarvis repository I mentioned: https://github.com/gorock007/jarvis"

The creator does not need to manually respond.

There are no follower requirements, verification steps, additional message requests, or complex automation builders.

## 1.1 Product philosophy

**Manychat does many things. FewChat does a few things really well.**

Build the smallest reliable system that solves one specific problem.

FewChat should be:

- Free and open source.
- Self-hostable.
- Easy to install and configure.
- Built using official Meta APIs.
- Reliable enough to operate unattended.
- Simple enough for creators without technical expertise.
- Extensible without unnecessary complexity.

FewChat is not intended to replicate every feature of Manychat.

---

# 2. Problem Statement

Content creators frequently share tutorials, templates, guides, repositories, PDFs, and other resources through Instagram.

A common engagement pattern is asking viewers to comment a keyword to receive a resource.

Without automation, creators must manually read comments, identify relevant users, open their DMs, send the resource, and track which users have already received it.

Existing services solve this problem but introduce subscriptions, usage-based costs, and functionality that individual creators may not need.

FewChat provides a self-hosted alternative focused on automating this simple interaction.

---

# 3. Goals and Non-Goals

## 3.1 Primary goals

**G1. Automated comment detection**

Detect new comments on connected Instagram posts and Reels using official Meta webhooks.

**G2. Rule-based triggering**

Allow creators to trigger automations based on a keyword or any comment.

**G3. Automatic resource delivery**

Send the configured resource directly in the first Instagram private reply.

**G4. Reliability**

Prevent duplicate messages, handle API failures, and recover eligible comments missed by webhooks.

**G5. Simple administration**

Provide a dashboard for managing automations, Instagram connectivity, and delivery history.

**G6. Self-hosting**

Allow developers to deploy and operate FewChat using their own Meta app and infrastructure.

## 3.2 Non-goals for MVP

Do not implement:

- Follower verification or follow gating.
- AI chatbots or AI-generated conversations.
- Visual workflow builders.
- Multi-step DM sequences.
- Broadcast or mass marketing messages.
- WhatsApp or Facebook Messenger.
- Instagram Story automation.
- Instagram Live comment automation.
- Multiple Instagram accounts per instance.
- Multi-user organisations or teams.
- Payments, subscriptions, or billing.
- CRM functionality.
- Contact scraping.
- Browser automation or unofficial Instagram APIs.
- Scheduled promotional follow-up DMs.

These features are explicitly out of scope unless separately approved.

---

# 4. Target User

## Primary user

An individual Instagram creator who regularly shares free resources through their posts and Reels.

Examples include developers sharing GitHub repositories, educators sharing guides, designers sharing templates, and founders sharing useful tools.

## Deployment model

Version 1 supports:

- One creator.
- One Instagram professional account.
- One administrator.
- Multiple posts and automations.
- One self-hosted FewChat instance.

The architecture should not unnecessarily prevent multi-account support in future versions, but multi-tenancy must not be implemented in the MVP.

Each self-hosted instance uses its own Meta application credentials.

---

# 5. Core User Experience

## 5.1 Initial setup

The admin opens FewChat for the first time.

They are guided through:

1. Creating or connecting a Meta developer app.
2. Connecting an Instagram professional account.
3. Configuring the webhook callback.
4. Confirming required permissions.
5. Verifying the Instagram connection.
6. Creating their first automation.

The interface must provide clear setup instructions and actionable errors.

## 5.2 Creating an automation

The creator selects "New Automation".

The form contains:

| Field | Description |
|---|---|
| Automation name | Internal descriptive name |
| Instagram post | Select a connected post or Reel |
| Trigger type | Keyword or any comment |
| Keyword | Required for keyword triggers |
| Match mode | Whole word, exact, or contains |
| DM message | Message sent to commenter |
| Resource URL | Link delivered in the DM |
| Public reply | Optional public comment reply |
| Active | Enable or disable automation |

### Example configuration

**Automation name:** Jarvis GitHub Resource

**Instagram post:** My latest Jarvis Reel

**Trigger type:** Keyword

**Keyword:** JARVIS

**Match mode:** Whole word, case-insensitive

**DM message:**

"Hey {username}! Here's the resource I mentioned: {resource_url}"

**Resource URL:** https://github.com/gorock007/jarvis

**Public reply:** Disabled

**Active:** Enabled

## 5.3 Comment arrives

Someone comments:

"Can you send me JARVIS?"

FewChat:

1. Receives the Meta webhook.
2. Verifies the event.
3. Identifies the Instagram post.
4. Loads the active automation.
5. Matches the keyword.
6. Checks whether the comment has already been processed.
7. Enqueues the delivery.
8. Sends the private reply.
9. Saves the API response and delivery status.

The creator does not need to be online.

## 5.4 Resource delivery

The recipient receives a single message:

"Hey! Here's the resource I mentioned: https://github.com/gorock007/jarvis"

The MVP uses a plain-text message containing the resource URL.

Clickable link-button templates are not required for the initial implementation.

Users do not need to follow the creator to receive the resource.

Instagram may place messages to non-followers in their Message Requests folder.

---

# 6. Functional Requirements

## FR-01: Instagram Account Connection

**Priority: P0**

FewChat must support connecting one Instagram professional account through Meta's official Instagram Login flow.

Requirements:

- Support Instagram Business and Creator accounts.
- Use Meta OAuth.
- Do not collect Instagram passwords.
- Store access tokens encrypted at rest.
- Retrieve the connected account's ID, username, and profile information.
- Display connection status.
- Support reconnection and disconnection.
- Automatically refresh tokens before expiration.
- Detect revoked, invalid, or expired permissions.

Use Instagram API with Instagram Login unless early testing establishes that another officially supported integration is necessary.

A Facebook Page must not be required by FewChat's own design when Instagram Login supports the required functionality.

## FR-02: Media Selection

**Priority: P0**

Fetch and display recent Instagram posts and Reels belonging to the connected account.

Display:

- Thumbnail.
- Caption excerpt.
- Publication date.
- Media type.
- Instagram permalink.

Allow the admin to select one media item when creating an automation.

Store the media ID rather than using the public Instagram URL as the primary identifier.

Support pagination.

MVP does not need access to Stories, Live broadcasts, advertisements, or media belonging to other accounts.

## FR-03: Automation Management

**Priority: P0**

The creator must be able to:

- Create an automation.
- Edit an automation.
- Enable or pause an automation.
- Delete an automation with confirmation.
- View all automations.
- View delivery activity associated with an automation.

Each automation belongs to a single Instagram media item.

For MVP, permit only one active automation per media item to avoid conflicting rules.

Deleting an automation must not remove historical delivery records needed for troubleshooting unless requested through a data-deletion process.

## FR-04: Comment Triggers

**Priority: P0**

Support two trigger types.

### A. Keyword trigger

Send a DM when the comment matches a specified keyword.

Supported matching modes:

- **Exact:** The entire trimmed comment equals the keyword.
- **Whole word:** The keyword appears as a standalone word or phrase.
- **Contains:** The keyword appears anywhere in the comment.

Matching must be case-insensitive and Unicode-aware.

Example using the keyword `GUIDE`:

| Comment | Whole-word match |
|---|---|
| GUIDE | Yes |
| guide please | Yes |
| Can I have the GUIDE? | Yes |
| GUIDELINES | No |

Handle punctuation, emojis, whitespace, and non-ASCII text sensibly.

### B. Any-comment trigger

Trigger on any eligible new top-level comment for the selected post.

Empty or unsupported comment payloads must be handled safely.

### Exclusions

Never trigger on:

- Comments created by the connected Instagram account itself.
- Replies generated by the automation.
- Comments on media not associated with an active automation.
- Duplicate events.
- Comments outside the private-reply eligibility window.

Ignore nested comment replies for MVP to avoid accidental loops and ambiguous behaviour.

## FR-05: Automatic Instagram DM

**Priority: P0**

When an eligible comment matches an automation, send one private reply using Meta's official Private Replies API.

Requirements:

- Address the reply using the comment ID.
- Send the resource in the first private reply.
- Support a configurable message template.
- Support `{username}`, `{keyword}`, and `{resource_url}` placeholders.
- Gracefully handle unavailable template values.
- Keep message content within documented Meta limits.
- Record Meta's returned message ID and recipient ID when available.
- Do not attempt automated follow-up messages.

### Default message

"Hey! Here's the resource you asked for: {resource_url}"

A non-follower is just as eligible as a follower.

### Delivery restriction

Meta allows one private reply per comment within seven days of the comment being created for posts and Reels.

FewChat must enforce this limitation.

A successful API response means Meta accepted the request. It must not be represented as proof that the recipient viewed the message.

## FR-06: Duplicate Prevention

**Priority: P0**

A comment must not cause duplicate automated DMs.

Requirements:

- Use the comment ID as the primary deduplication key.
- Enforce a database uniqueness constraint per Instagram account and comment ID.
- Deduplicate repeated webhooks.
- Deduplicate polling-discovered comments already processed.
- Use atomic delivery claims to prevent concurrent workers from sending the same reply.
- Ensure repeated events never reset a successful delivery.

### Additional anti-spam behaviour

Default to one resource DM per commenter per automation.

If someone comments the keyword multiple times on the same post, FewChat should send the resource once rather than repeatedly.

Make this setting configurable in the data model but keep it enabled by default.

Record subsequent comments as skipped.

## FR-07: Optional Public Comment Reply

**Priority: P1**

Allow creators to optionally reply publicly under a triggering comment.

Example:

"Sent it! Check your DMs."

Public replies should be disabled by default.

Requirements:

- Use Meta's official comment reply endpoint.
- Send only after the DM API accepts the private reply.
- Prevent duplicate public replies.
- Store public reply status separately.
- Allow custom reply text.

Failure to send the public reply must not cause the DM to be resent.

## FR-08: Delivery History

**Priority: P0**

Provide an Activity page showing:

- Comment timestamp.
- Username, if available.
- Comment excerpt.
- Matched automation.
- Trigger.
- DM status.
- Public reply status.
- Processing time.
- Error category, if applicable.

Possible delivery statuses:

- RECEIVED
- SKIPPED
- QUEUED
- SENDING
- SENT
- RETRYABLE_FAILED
- PERMANENT_FAILED
- DELIVERY_UNKNOWN
- EXPIRED

SENT means Meta acknowledged the request.

DELIVERY_UNKNOWN means the request may have reached Meta, but FewChat could not establish the result.

Do not automatically resend DELIVERY_UNKNOWN messages.

## FR-09: Dashboard Analytics

**Priority: P1**

Provide a lightweight dashboard displaying:

- Total matching comments.
- Private replies accepted by Meta.
- Failed deliveries.
- Currently queued deliveries.
- Active automations.
- Instagram connection health.

Counters must be based on actual database records.

Do not claim to measure actual inbox delivery or message views without appropriate data.

## FR-10: Global Pause Control

**Priority: P0**

Provide a global switch to pause all outgoing messages.

When paused:

- Continue receiving and recording valid webhooks.
- Do not send DMs.
- Do not send public replies.
- Retain queued deliveries.
- Clearly show that processing is paused.

When resumed:

- Re-evaluate queued items against the active automation and seven-day eligibility window.
- Never send expired messages.
- Never resend already accepted or uncertain deliveries.

## FR-11: Missed-Comment Recovery

**Priority: P1**

Provide a "Check Missed Comments" action for an automation.

FewChat fetches recent comments from the selected media and checks them against existing delivery records.

Eligible missing comments can be added to the queue.

Requirements:

- Respect pagination and API rate limits.
- Do not duplicate deliveries.
- Do not process comments older than seven days.
- Show how many comments were inspected and recovered.
- Reuse the same matching and delivery pipeline.

Automatic periodic reconciliation is also required for production reliability.

---

# 7. Meta API Integration

## 7.1 Integration method

Use the official Instagram API with Instagram Login.

Primary API host:

`https://graph.instagram.com`

All API calls must use a centrally configured, supported Graph API version.

Do not hardcode an unverified API version throughout the application.

## 7.2 Required permissions

Start with the documented Instagram Login permissions:

- `instagram_business_basic`
- `instagram_business_manage_comments`

Evaluate whether `instagram_business_manage_messages` is additionally required for the selected implementation.

Existing open-source implementations request it, while Meta's Instagram Login Private Replies documentation lists the first two permissions.

Request only the permissions FewChat actually needs.

Do not request publishing, advertising, insights, or unrelated access.

## 7.3 Webhook subscription

Subscribe to:

`comments`

Follow-gate postbacks, generic inbox messages, Story replies, and other webhook fields are unnecessary for MVP.

Use one HTTPS webhook endpoint:

`/api/webhooks/instagram`

### GET request

Handle Meta verification using the challenge and verification token.

### POST request

1. Read the original raw request body.
2. Verify `X-Hub-Signature-256` using the Meta app secret.
3. Use a timing-safe comparison.
4. Validate the event structure.
5. Persist the event to durable storage.
6. Enqueue or mark it ready for background processing.
7. Respond HTTP 200 promptly.

Do not process the entire DM delivery synchronously inside the webhook request.

If persistence fails, return an unsuccessful response instead of acknowledging an event that may be lost.

Never log access tokens, secrets, or entire sensitive webhook payloads.

## 7.4 Private reply request

Conceptual API request:

**Endpoint:** `POST /{instagram_account_id}/messages`

**Recipient:**
`{ "comment_id": "<instagram_comment_id>" }`

**Message:**
`{ "text": "<rendered_message>" }`

Use the appropriate Meta Graph API host, version, and access token.

Store returned identifiers such as `recipient_id` and `message_id`.

Do not depend on follower status.

## 7.5 Messaging policies

FewChat must respect:

- One private reply per comment.
- Seven-day eligibility for posts and Reels.
- The platform's rate limits.
- No unsolicited automated follow-up messages.
- No follower requirement.
- No undocumented workarounds to bypass Meta restrictions.

If Meta rejects a request due to permissions, eligibility, spam controls, or permanent restrictions, classify the failure and stop retrying.

## 7.6 API rate limiting

Meta documents a limit of 750 private replies per hour per professional Instagram account for posts and Reels.

Use a configurable per-account rate limiter, with a conservative initial limit of 600 sends per rolling hour.

Also limit short bursts.

When rate-limited:

- Respect `Retry-After` where available.
- Apply bounded exponential backoff with jitter.
- Retain jobs in the queue.
- Do not exceed the seven-day eligibility window.
- Surface a warning in the dashboard.

Never attempt to bypass Meta limits.

## 7.7 Mandatory Meta feasibility validation

Meta's App Review documentation distinguishes Standard Access for accounts owned or managed by the developer from Advanced Access for broader use.

Older Instagram webhook documentation contains stricter Advanced Access language.

This must be validated for FewChat's intended configuration.

### Mandatory tests

Use a real professional Instagram account.

Test comments from:

1. An accepted Instagram test account.
2. A separate Instagram account with no Meta app role.
3. A separate Instagram account that does not follow the creator.

Verify:

- The webhook arrives.
- The comment includes sufficient identifiers.
- The private reply API accepts the request.
- The recipient can see the DM or Message Request.
- The flow works in the intended production configuration.

If public events are blocked, determine the actual required permissions and App Review process.

Do not claim production readiness until this test passes.

---

# 8. Technical Architecture

## 8.1 Recommended stack

| Component | Technology |
|---|---|
| Language | TypeScript |
| Framework | Next.js App Router |
| UI | React, Tailwind CSS, shadcn/ui |
| Database | PostgreSQL |
| ORM | Drizzle |
| Job processing | PostgreSQL-backed durable queue |
| Worker | Node.js |
| Web deployment | Vercel |
| Worker deployment | Fly.io or Railway |
| Authentication | Single-admin secure session |
| Instagram | Official Meta Graph API |
| Testing | Vitest and Playwright |
| Containers | Docker |

Use the same PostgreSQL database for application data and durable jobs.

Redis is not required for MVP.

The worker must support safe concurrent execution, even if only one replica is initially deployed.

## 8.2 Architecture flow

Instagram Comment

→ Meta Comments Webhook

→ FewChat Webhook Handler

→ Signature Verification

→ PostgreSQL Event Storage

→ Background Worker

→ Automation Matching

→ Deduplication and Delivery Claim

→ Per-Account Rate Limiter

→ Instagram Private Replies API

→ Save Delivery Result

→ Update FewChat Dashboard

## 8.3 Background worker

Do not rely exclusively on Next.js `after()` or in-memory processing.

Use durable PostgreSQL-backed jobs.

The worker must:

- Claim jobs atomically.
- Use row-level locking or equivalent protection.
- Prevent concurrent sends for the same comment.
- Recover abandoned jobs safely.
- Respect scheduled retry times.
- Respect global pause.
- Respect seven-day eligibility.
- Record operational metrics.

### External side-effect safety

A database transaction cannot guarantee an exactly-once Instagram API request.

If a worker sends a message and crashes before persisting the response, Meta may have accepted the request.

Therefore:

- Mark ambiguous sends as DELIVERY_UNKNOWN.
- Never retry them blindly.
- Retry only when an explicit rejection or known pre-send failure makes retry safe.
- Provide a manual resolution mechanism.

Prefer avoiding duplicate DMs over maximising deliveries through uncertain retries.

---

# 9. Database Design

The implementation can refine field names, but must preserve this logical structure.

## 9.1 instagram_accounts

- id
- instagram_user_id
- username
- account_type
- encrypted_access_token
- token_expires_at
- connection_status
- webhook_subscription_status
- last_connected_at
- created_at
- updated_at

## 9.2 automations

- id
- instagram_account_id
- name
- media_id
- media_type
- trigger_type
- keyword
- match_mode
- dm_template
- resource_url
- public_reply_enabled
- public_reply_template
- once_per_user
- is_active
- created_at
- updated_at

## 9.3 webhook_events

- id
- event_key
- event_type
- instagram_account_id
- received_at
- processing_status
- processed_at
- error_category

Store only the payload fields required for matching, auditing, and recovery.

Enforce uniqueness for identifiable repeated events.

## 9.4 deliveries

- id
- instagram_account_id
- automation_id
- comment_id
- commenter_igsid
- commenter_username
- comment_text_excerpt
- comment_created_at
- source
- status
- meta_message_id
- meta_recipient_id
- public_reply_status
- public_reply_id
- attempt_count
- last_error_code
- last_error_message
- created_at
- sent_at
- updated_at

Constraints:

- Unique `instagram_account_id + comment_id`.
- Index on `automation_id + status`.
- Index on `comment_created_at`.
- Index on commenter identity and automation where available.

Enforce the optional once-per-user rule transactionally.

## 9.5 jobs

- id
- job_type
- delivery_id
- status
- run_after
- locked_at
- locked_by
- attempts
- created_at
- updated_at

Jobs must survive process and application restarts.

## 9.6 operational_events

- id
- severity
- category
- safe_message
- related_delivery_id
- created_at

Use this for API errors, webhook failures, token refresh issues, and worker diagnostics.

---

# 10. Reliability Requirements

## 10.1 Webhook reliability

Assume Meta events may:

- Arrive late.
- Arrive more than once.
- Arrive out of order.
- Be missed during outages.
- Be unavailable for certain comments.

All event handling must be idempotent.

### Recovery strategy

Run periodic reconciliation for active automations.

Initial interval: every 5–10 minutes, configurable.

Each reconciliation pass should:

1. Fetch recent comments.
2. Compare comment IDs against stored records.
3. Enqueue eligible missing comments.
4. Respect pagination and rate limits.
5. Avoid unnecessary requests.
6. Log processing results.

Use an initial lookback of 72 hours.

Provide a manual rescan option within the seven-day eligibility window.

Do not assume every hidden, deleted, filtered, or API-inaccessible comment can be recovered.

## 10.2 Error classification

| Error | Behaviour |
|---|---|
| Invalid webhook signature | Reject |
| Database unavailable | Fail webhook acknowledgment |
| Duplicate event | Ignore safely |
| Rate limit | Reschedule |
| Pre-send temporary failure | Retry with backoff |
| Explicit retryable Meta rejection | Retry while eligible |
| Invalid token | Pause and request reconnection |
| Missing permission | Permanent failure |
| Expired comment | Mark EXPIRED |
| Already replied | Mark handled |
| Uncertain send timeout | Mark DELIVERY_UNKNOWN |
| Invalid resource URL | Reject configuration |

A worker restart must not cause duplicate sends.

## 10.3 Token refresh

Implement scheduled token-refresh handling.

Requirements:

- Track expiration.
- Refresh supported long-lived tokens before expiry.
- Use the documented Instagram Login refresh mechanism.
- Encrypt replacement tokens.
- Detect refresh failures.
- Surface account warnings.
- Stop sends when authorization is lost.

Run daily checks and start refresh attempts sufficiently early.

## 10.4 Delivery guarantees

FewChat should aim for:

- At-least-once processing of durably stored events.
- No duplicate sends from repeated webhooks.
- No blind retries when external delivery is uncertain.
- Clear identification of failed, expired, or ambiguous messages.

Do not advertise exactly-once Instagram delivery.

---

# 11. Security and Privacy

## 11.1 Authentication

FewChat's dashboard is private.

MVP supports one admin.

Requirements:

- Secure password hashing.
- HTTP-only, Secure, SameSite session cookies.
- Session expiration and revocation.
- Rate-limited login attempts.
- CSRF protection.
- No public registration.
- No default production password.

## 11.2 Credential protection

- Encrypt Instagram tokens at rest.
- Keep Meta credentials server-side.
- Never expose tokens to browser code.
- Never log secrets.
- Use environment variables for secrets and encryption keys.
- Document key rotation and backup considerations.

## 11.3 Webhook security

Verify raw webhook requests with HMAC-SHA256 and a timing-safe comparison.

Reject unsupported or invalid payloads safely.

Apply reasonable request-size limits.

## 11.4 Data minimisation

Store only the commenter information necessary for delivery and troubleshooting.

Avoid collecting unrelated Instagram information.

Default to configurable retention, initially 30 days for commenter-level delivery information, unless a stricter Meta requirement applies.

Include admin data-deletion controls.

Document privacy and deletion obligations for production Meta apps.

Implement deauthorization and data-deletion callbacks when required by the selected integration.

## 11.5 Content validation

Only allow HTTP/HTTPS resource URLs, preferring HTTPS.

Render templates safely.

Never execute template content as code.

Do not make arbitrary backend requests to user-supplied URLs just to validate their existence.

---

# 12. Dashboard Requirements

FewChat should have a minimal, responsive interface.

## Page 1: Overview

Show:

- Instagram connection status.
- Active automations.
- Matching comments.
- Accepted DMs.
- Failed or uncertain deliveries.
- Global pause status.
- Recent activity.

Primary action: **Create Automation**

## Page 2: Automations

Display:

- Automation name.
- Media thumbnail.
- Trigger.
- Active status.
- Accepted DM count.
- Last triggered date.

Actions:

- Create.
- Edit.
- Pause/resume.
- Delete.
- View activity.

## Page 3: Create/Edit Automation

Include:

1. Media selector.
2. Trigger type.
3. Keyword and match mode.
4. DM message editor.
5. Resource URL.
6. Optional public reply.
7. Live message preview.
8. Save and enable.

Validate templates and resource URLs before activation.

## Page 4: Activity

Display:

- Timestamp.
- Username.
- Comment excerpt.
- Automation.
- Delivery status.
- Error details.

Filters:

- Automation.
- Status.
- Date range.

Include **Check Missed Comments**.

## Page 5: Settings

Include:

- Instagram connection.
- Reconnect/disconnect.
- Webhook subscription status.
- Webhook URL.
- Last webhook received.
- Last reconciliation.
- Last token refresh.
- Global pause switch.
- Data retention.
- System health.

Do not add billing, CRM, AI features, or unnecessary analytics during MVP.

---

# 13. Non-Functional Requirements

## Performance

- Webhook acknowledgment target: under 2 seconds when dependencies are healthy.
- Start processing promptly after durable event ingestion.
- Support desktop and mobile layouts.
- Background processing must not block dashboard requests.

These are application targets, not guaranteed Instagram delivery times.

## Reliability

- Durable event storage.
- Restart-safe queues.
- Idempotent processing.
- Per-account rate limits.
- Health monitoring.
- Safe API error handling.

## Maintainability

- Strict TypeScript.
- Modular Meta API client.
- Clear separation of domain logic and framework routes.
- Structured logging.
- Database migrations.
- Reusable error classification.
- Automated tests.
- Setup documentation.

## Self-hostability

Support:

- Local development.
- Production deployment.
- Docker-based setup.
- Environment-variable configuration.
- Database migration commands.
- HTTPS webhook configuration.

FewChat must not depend on a proprietary Instagram automation provider.

---

# 14. Open-Source Reuse Strategy

Review existing implementations before writing the Meta integration from scratch.

## A. AutoDM

Repository:

https://github.com/ilramdhan/auto-dm

Useful components:

- Instagram OAuth.
- Webhook verification.
- Comment processing.
- Campaign and keyword matching.
- Delivery storage.
- Token encryption.
- Token refresh.
- Single-admin dashboard.

Relevant files:

- `src/server/engine/process-comment.ts`
- `src/server/instagram/inbound.ts`
- `src/app/api/webhooks/instagram/route.ts`
- `src/server/instagram/oauth.ts`
- `src/server/db/schema.ts`

## B. OpenReply

Repository:

https://github.com/diwenne/openreply

Useful components:

- Background processing.
- Meta API client.
- Polling reconciler.
- Rate limiting.
- Atomic delivery claims.
- Delivery-uncertainty handling.
- Worker diagnostics.

Relevant files:

- `lib/meta/client.ts`
- `lib/queue/dm-worker.ts`
- `lib/queue/comment-delivery.ts`
- `lib/polling/comment-reconciler.ts`
- `lib/queue/client.ts`

## Implementation decision

Use AutoDM as the primary reference for the product and direct Meta integration.

Borrow OpenReply's reliability patterns.

Do not copy its entire infrastructure if simpler PostgreSQL-backed jobs meet the requirements.

Both projects use MIT licenses. Preserve applicable copyright and license notices when reusing code.

Review maintenance status, dependencies, tests, security, and complexity before deciding whether to fork or implement a smaller version.

FewChat must exclude unnecessary follower gating, billing, extra providers, and multi-account functionality.

---

# 15. Implementation Plan

## Phase 0: Meta Feasibility Spike

**Priority: Blocking**

Before building the full dashboard:

- Create the Meta developer app.
- Configure Instagram Login.
- Connect a professional Instagram account.
- Verify OAuth and permissions.
- Configure signed webhooks.
- Subscribe to comments.
- Receive a real comment event.
- Send a private reply containing a test URL.
- Test with a non-tester account.
- Test with a non-follower.
- Document any App Review requirements.

### Deliverable

A minimal working end-to-end comment-to-DM proof of concept.

Record:

- Meta app configuration.
- Permissions and access levels.
- API host and version.
- Webhook payload structure.
- Private reply response.
- Known limitations.

If public-comment delivery is blocked, investigate the permissions and review requirements before expanding the product.

Do not treat Meta's sample webhook tool as sufficient proof.

## Phase 1: Core Backend

Implement:

- Database schema and migrations.
- Instagram account management.
- Meta API client.
- Webhook signature verification.
- Event persistence.
- Keyword matching.
- Automation matching.
- Private reply delivery.
- Deduplication.
- Durable queue.
- Rate limiting.
- Error handling.
- Global pause.

### Deliverable

Working backend with automated tests and minimal admin controls.

## Phase 2: Dashboard

Implement:

- Admin authentication.
- Overview.
- Automation management.
- Create/edit automation.
- Instagram media selector.
- Activity history.
- Settings.
- Connection health.
- Error and loading states.

### Deliverable

A complete usable FewChat MVP.

## Phase 3: Reliability Hardening

Implement:

- Comment reconciliation.
- Manual missed-comment recovery.
- Token refresh.
- Worker heartbeat.
- Retry handling.
- Delivery-uncertainty handling.
- Connection diagnostics.
- Retention and data deletion.
- Monitoring.
- End-to-end failure testing.

### Deliverable

An unattended, self-hostable application suitable for real creator usage.

## Phase 4: Open-Source Release

Complete:

- MIT LICENSE.
- README.
- `.env.example`.
- Docker setup.
- Setup guide.
- Meta app guide.
- Troubleshooting guide.
- Architecture documentation.
- CI.
- Example screenshots.
- Security policy.
- Contribution instructions.

### Deliverable

A public FewChat repository another developer can deploy using their own Meta credentials.

---

# 16. Acceptance Criteria

## Functional

- [ ] Admin can connect an Instagram professional account.
- [ ] Admin can select a post or Reel.
- [ ] Admin can create keyword-trigger automations.
- [ ] Admin can create any-comment automations.
- [ ] A matching comment triggers a private reply.
- [ ] A non-follower can receive the resource.
- [ ] No follower checks are performed.
- [ ] Resource URL appears in the first private reply.
- [ ] Unmatched comments do not trigger DMs.
- [ ] Comments from the connected account are ignored.
- [ ] Paused automations do not send.
- [ ] Public replies are optional and default off.
- [ ] Admin can inspect delivery history.

## Reliability

- [ ] Repeated webhooks do not cause duplicate sends.
- [ ] Concurrent workers cannot intentionally duplicate replies.
- [ ] Once-per-user behaviour is enforced.
- [ ] Failed event persistence does not silently acknowledge webhooks.
- [ ] Uncertain sends are not retried blindly.
- [ ] Explicit transient failures retry safely.
- [ ] Permanent errors stop retrying.
- [ ] Rate limits are respected.
- [ ] Queued jobs survive restarts.
- [ ] Expired comments are never sent.
- [ ] Reconciliation respects deduplication.
- [ ] Invalid tokens trigger visible warnings.

## Security

- [ ] Webhook signature verification is tested.
- [ ] Instagram tokens are encrypted.
- [ ] Secrets are not exposed client-side.
- [ ] Admin authentication protects private routes.
- [ ] Mutations validate inputs.
- [ ] Data retention and deletion work.

## Meta integration

- [ ] Real webhook received from a tester.
- [ ] Real webhook received from a non-tester in the intended production configuration.
- [ ] Real private reply accepted by Meta.
- [ ] Non-follower delivery tested.
- [ ] Required permissions documented.
- [ ] No unofficial Instagram endpoints.

## Open source

- [ ] README setup works.
- [ ] Docker development setup works.
- [ ] Production deployment documented.
- [ ] Environment variables documented.
- [ ] No private credentials committed.
- [ ] Automated tests and build pass.
- [ ] Third-party license notices retained.

---

# 17. Testing Strategy

## Unit tests

Cover:

- Exact matching.
- Whole-word matching.
- Contains matching.
- Case insensitivity.
- Unicode and emoji handling.
- Template substitution.
- Missing placeholders.
- Invalid URLs.
- Duplicate detection.
- Eligibility calculations.
- Rate-limit calculations.
- Meta error classification.

## Integration tests

Cover:

- Valid and invalid signatures.
- Webhook persistence.
- Duplicate webhook events.
- Concurrent processing.
- Automation matching.
- Pause/resume.
- Successful private reply.
- Explicit API rejection.
- Network timeout.
- Expired tokens.
- Job recovery.
- Polling and webhook overlap.

Use mocked Meta responses and a real test PostgreSQL database for transactional tests.

## End-to-end tests

Cover:

- Admin login.
- Instagram settings.
- Automation creation.
- Pause/resume.
- Activity page.
- Manual reconciliation.

Use Playwright.

Live Instagram integration tests must use controlled accounts and remain separate from routine CI.

---

# 18. Monitoring and Operations

Track:

- Webhook requests.
- Invalid signatures.
- Valid comment events.
- Matching comments.
- Queued deliveries.
- Accepted private replies.
- Failed deliveries.
- Uncertain deliveries.
- Rate-limited requests.
- Queue age.
- Worker heartbeat.
- Token expiration.
- Last successful reconciliation.

Show warnings when:

- The worker stops reporting health.
- Instagram authorization fails.
- Failed deliveries exceed a configured threshold.
- The queue accumulates unexpectedly.
- Meta rejects requests.
- No webhook activity is observed for an unusual period.

Distinguish inactivity from a confirmed webhook failure.

Keep logs structured and avoid unnecessary personal data.

---

# 19. Future Extensions

Potential future features:

- Multiple Instagram accounts.
- Multiple rules on one post.
- Automatically attach automations to new Reels.
- Reusable message templates.
- Resource library.
- Optional tracked links.
- Link-click analytics.
- Optional link-button messages.
- Additional social platforms.
- Hosted SaaS offering.
- Multiple administrators.

These must not delay the MVP.

Future messaging functionality must comply with Meta's policies.

---

# 20. Definition of Done

FewChat is ready for MVP release when:

1. A creator can deploy the application.
2. They can connect their Instagram account.
3. They can create an automation without editing code.
4. A real non-follower comments a configured keyword on a Reel.
5. The commenter receives the configured resource through one automated private reply.
6. Duplicate events do not cause duplicate sends.
7. The system recovers safely from common failures.
8. The creator can inspect delivery activity and pause processing.
9. The application operates unattended during normal use.
10. Security, testing, and documentation requirements are satisfied.

The live Meta integration, particularly with a non-tester account, is essential.

---

# 21. Instructions for the Coding Agent

You are responsible for implementing **FewChat**, the open-source Instagram comment-to-DM automation tool described in this PRD.

The product should be named FewChat throughout the application, code documentation, package metadata, deployment configuration, and README.

Use `fewchat` as the project/repository name.

Work autonomously and make reasonable technical decisions within the specified scope.

Follow these instructions:

1. Audit AutoDM and OpenReply before implementation. Identify useful components, relevant tests, dependencies, security concerns, and licensing obligations.

2. Decide whether forking AutoDM or implementing a smaller solution using selected patterns is more maintainable. Record this in an architecture decision record.

3. Prioritise Phase 0. Test the actual Meta integration before investing significant effort in the UI. If live credentials or approval are unavailable, continue with locally testable implementation and clearly document the blocker. Never fabricate successful live integration evidence.

4. Follow the architecture and requirements in this PRD. Prefer simple solutions over extra infrastructure.

5. Separate Meta integration, business logic, persistence, background processing, and UI.

6. Build with tests. Mock Meta API responses in automated tests and preserve realistic fixtures.

7. Respect Meta's official permissions, rate limits, and messaging restrictions.

8. Do not implement follower verification, follow gating, AI chatbots, billing, or multi-user SaaS features.

9. Deliver database migrations, environment configuration, deployment documentation, and automated checks.

10. Commit logically separated changes and validate tests before marking milestones complete.

11. Maintain an implementation progress document identifying completed work, unresolved risks, limitations, and required external setup.

12. Treat the acceptance criteria as mandatory. A functioning dashboard or passing mocked API tests alone do not establish production readiness.

### Final deliverables

- FewChat application source code.
- PostgreSQL migrations.
- Durable background worker.
- Automated tests.
- Docker configuration.
- `.env.example`.
- Self-hosting documentation.
- Meta app configuration guide.
- Architecture decision record.
- Production-readiness report.

### Primary success condition

A user who does not follow the creator comments a configured keyword on the creator's Instagram Reel and receives the configured resource through one automated private reply, without duplicate sends.

---

# 22. Reference Documentation

## Official Meta documentation

Private Replies:  
https://developers.facebook.com/documentation/instagram-platform/private-replies

Instagram Login:  
https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login

Instagram App Review:  
https://developers.facebook.com/documentation/instagram-platform/app-review

Instagram Webhooks:  
https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-instagram

Graph API Rate Limits:  
https://developers.facebook.com/docs/graph-api/overview/rate-limiting/

## Open-source references

AutoDM:  
https://github.com/ilramdhan/auto-dm

OpenReply:  
https://github.com/diwenne/openreply

Verify version-sensitive requirements against Meta's current official documentation during implementation.

---

**FewChat**

*Less automation. Just what you need.*
