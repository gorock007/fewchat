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
- 2026-11-16 · d1-schema · Q1 once-per-user: if a commenter's first DM ends PERMANENT_FAILED or EXPIRED, should their next comment on that automation get a DM (release the slot) or stay skipped? Needed before 2b

## Running workers
<!-- `jarvis spawn` adds: - <date HH:MM> · claude/claude-opus-5-5 high · term <id> · handoffs/briefs/<file>.md -->
<!-- `jarvis merge` removes the line -->

## Waiting on Jarvis
<!-- - handoff to review: handoffs/<file>.md · migration to apply · release to cut -->
- 1b + 1c reviewed; fixes sent back to both workers (1b: finish from UNKNOWN, FK index, seed timestamp · 1c: <400 never classified, redirect manual, https, not_sent guards, 1 MiB cap). Merge each when its handoff is updated

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
Plan (docs/architecture/free-first-amendment.md; static export + 1 Worker agreed):
- Step 1: 1a merged 5930fa5; 1b D1 schema (claude 7be43a5a) ∥ 1c Meta client (codex e771fed1) running
- Step 2 (2a: call recordEvents per entry so one bad row doesn't fail the batch; 2b: deferDelivery bumping next_attempt_at on rate_limited, slot release per Q1, check sends_paused/connection before claim): 2a webhook ingest ∥ 2b delivery consumer → 2c cron (recovery, reconciliation, token refresh) + CLI seed script · 2a: pick one webhook path (fact sheet says /api/webhooks/instagram, wrangler lists /webhook) and drop the other from run_worker_first
- Step 3: live Meta test — user (CF deploy, Meta app, 3 IG accounts: tester, no-role, non-follower). Go/no-go before UI
- Step 4: 4a auth (PBKDF2, sessions, CSRF) + Instagram OAuth ∥ 4b dashboard (client-rendered, /api)
- Step 5: hardening + OSS docs/CI; keep docs/PROGRESS.md current at every merge
