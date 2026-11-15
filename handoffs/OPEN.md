# Open items

Jarvis reads this first, every session, and keeps it current. One line per
item; an item goes in when it opens and comes out when it's done. Don't
rebuild "what's pending" by searching the handoff folders. Before Jarvis
stops, this file must hold everything a fresh session needs: `jarvis watch`
may `/clear` Jarvis after a long idle. Finished notes go to `jarvis log`,
not here.

Jarvis session: 91e82b5a-dca5-46f8-8a45-a825cf054f34
Usage band: amber (5h 4% used, 18:02)

## Questions for the user
<!-- - <date> · <slug> · Q1 …  (batched from worker handoffs; remove when answered and passed back) -->

## Running workers
- 2026-11-15 18:11 · claude/claude-opus-5-5 high · term e8b76d23-18d5-4d93-bfff-bbb00601f584 · handoffs/briefs/2026-11-15-1812-schema-queue.md
<!-- `jarvis spawn` adds: - <date HH:MM> · claude/claude-opus-5-5 high · term <id> · handoffs/briefs/<file>.md -->
<!-- `jarvis merge` removes the line -->

## Waiting on Jarvis
<!-- - handoff to review: handoffs/<file>.md · migration to apply · release to cut -->

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
- Ask user: may I wrap `test:e2e` and docker-backed `test:db` in `jarvis lock` (heavy suites)
- After ADR + Meta fact sheet: Meta error classification + Meta API client (src/meta) → webhook route + ingest → delivery worker
- Phase 0 spike: OAuth + signed webhook + private reply PoC; live test is the user's (needs Meta app, test + non-tester + non-follower accounts)
- Phase 1 core backend → Phase 2 dashboard → Phase 3 hardening → Phase 4 OSS release (PRD §15)
- Keep `docs/PROGRESS.md` (PRD §21.11) current at every merge
