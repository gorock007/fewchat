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
- 2026-11-15 · architecture · User proposed free-first Cloudflare amendment (Workers + D1 + Queues + Cron); build PAUSED pending their go-ahead on Jarvis's recommendation (static-export Next + one Worker)
<!-- - <date> · <slug> · Q1 …  (batched from worker handoffs; remove when answered and passed back) -->

## Running workers
<!-- `jarvis spawn` adds: - <date HH:MM> · claude/claude-opus-5-5 high · term <id> · handoffs/briefs/<file>.md -->
<!-- `jarvis merge` removes the line -->

## Waiting on Jarvis
<!-- - handoff to review: handoffs/<file>.md · migration to apply · release to cut -->

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
- On go-ahead: save amendment as docs/adr/0002, spike (vinext check vs static export + 1 Worker; D1+Drizzle, Queue, cron, HMAC, CPU), port archive/postgres-schema-queue design to D1
- Ask user: may I wrap `test:e2e` and docker-backed `test:db` in `jarvis lock` (heavy suites)
- After ADR + Meta fact sheet: Meta error classification + Meta API client (src/meta) → webhook route + ingest → delivery worker
- Phase 0 spike: OAuth + signed webhook + private reply PoC; live test is the user's (needs Meta app, test + non-tester + non-follower accounts)
- Phase 1 core backend → Phase 2 dashboard → Phase 3 hardening → Phase 4 OSS release (PRD §15)
- Keep `docs/PROGRESS.md` (PRD §21.11) current at every merge
