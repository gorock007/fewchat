# Open items

Jarvis reads this first, every session, and keeps it current. One line per
item; an item goes in when it opens and comes out when it's done. Don't
rebuild "what's pending" by searching the handoff folders. Before Jarvis
stops, this file must hold everything a fresh session needs: `jarvis watch`
may `/clear` Jarvis after a long idle. Finished notes go to `jarvis log`,
not here.

Jarvis session: 91e82b5a-dca5-46f8-8a45-a825cf054f34
Usage band: amber (5h 9% used, 18:18)

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
- Step 1 (after spike ADR 0002): 1a infra (wrangler, Next export, Worker fetch/queue/scheduled, Hono /api, workers test pool; drop Docker/Postgres) → 1b D1 schema+claims (port archive/postgres-schema-queue) ∥ 1c Meta client + error classes (codex)
- Step 2: 2a webhook ingest ∥ 2b delivery consumer → 2c cron (recovery, reconciliation, token refresh) + CLI seed script
- Step 3: live Meta test — user (CF deploy, Meta app, 3 IG accounts: tester, no-role, non-follower). Go/no-go before UI
- Step 4: 4a auth (PBKDF2, sessions, CSRF) + Instagram OAuth ∥ 4b dashboard (client-rendered, /api)
- Step 5: hardening + OSS docs/CI; keep docs/PROGRESS.md current at every merge
