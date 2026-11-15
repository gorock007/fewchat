# Open items

Jarvis reads this first, every session, and keeps it current. One line per
item; an item goes in when it opens and comes out when it's done. Don't
rebuild "what's pending" by searching the handoff folders. Before Jarvis
stops, this file must hold everything a fresh session needs: `jarvis watch`
may `/clear` Jarvis after a long idle. Finished notes go to `jarvis log`,
not here.

Jarvis session: 91e82b5a-dca5-46f8-8a45-a825cf054f34
Usage band: amber (5h 1% used, 09:16)

## Questions for the user
<!-- - <date> · <slug> · Q1 …  (batched from worker handoffs; remove when answered and passed back) -->

## Running workers
<!-- `jarvis spawn` adds: - <date HH:MM> · claude/claude-opus-5-5 high · term <id> · handoffs/briefs/<file>.md -->
<!-- `jarvis merge` removes the line -->

## Waiting on Jarvis
<!-- - handoff to review: handoffs/<file>.md · migration to apply · release to cut -->

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
Plan (docs/architecture/free-first-amendment.md; static export + 1 Worker agreed):
- Step 1: code done (1a 5930fa5, 1c 26f9a8f, 1b 8db2e09); deployed-D1 gates 2/3/8 still to prove in Step 3
- Step 2: 2a/2b/2c merged (f34f74e: DMs flow end to end in Miniflare); 2d seed CLI + token refresh running (claude/sonnet 32c8af97) → 2e FR-11 missed-comment recovery/reconciliation (paged, D1 cursor, gate 3) · public replies (FR-07) still unbriefed · Codex limited until 14:27
- Step 3 (needs 2d): live Meta test — user (CF deploy via git-ignored wrangler.deploy.jsonc + secrets + remote D1 migrate [Jarvis applies], Meta app, pnpm seed account/automation, 3 IG accounts: tester, no-role, non-follower). Go/no-go before UI; 2e can run in parallel
- Step 4: 4a auth (PBKDF2, sessions, CSRF) + Instagram OAuth ∥ 4b dashboard (client-rendered, /api)
- Step 5: hardening + OSS docs/CI; keep docs/PROGRESS.md current at every merge · set assets.not_found_handling "404-page" so non-Worker misses (e.g. /webhook) skip the Worker · export migrationStatements from src/db/test-d1.ts and drop the harness copy · decide app_settings.last_webhook_at (Health page vs a write per webhook) · sweep poisoned rows: a row that always throws at claim keeps a sweep slot each tick (5 would stall it); add an attempt cap or alert
