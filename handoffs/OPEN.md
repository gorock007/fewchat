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
- 2b reviewed; 3 fixes sent to codex 65be5cc6 (key check before claim, status before needs_reconnect, conditional needs_reconnect). Re-verify and merge, then brief 2c

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
Plan (docs/architecture/free-first-amendment.md; static export + 1 Worker agreed):
- Step 1: code done (1a 5930fa5, 1c 26f9a8f, 1b 8db2e09); deployed-D1 gates 2/3/8 still to prove in Step 3
- Step 2: 2a merged; 2b delivery consumer (codex 65be5cc6) running → 2c cron (wire queue() to handleDeliveryBatch, sweep pending + quarantine, recovery, reconciliation, token refresh) + CLI seed script · public replies (FR-07) still unbriefed
- Step 3: live Meta test — user (CF deploy, Meta app, 3 IG accounts: tester, no-role, non-follower). Go/no-go before UI
- Step 4: 4a auth (PBKDF2, sessions, CSRF) + Instagram OAuth ∥ 4b dashboard (client-rendered, /api)
- Step 5: hardening + OSS docs/CI; keep docs/PROGRESS.md current at every merge · set assets.not_found_handling "404-page" so non-Worker misses (e.g. /webhook) skip the Worker · export migrationStatements from src/db/test-d1.ts and drop the harness copy · decide app_settings.last_webhook_at (Health page vs a write per webhook)
