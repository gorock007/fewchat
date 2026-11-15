# Open items

Jarvis reads this first, every session, and keeps it current. One line per
item; an item goes in when it opens and comes out when it's done. Don't
rebuild "what's pending" by searching the handoff folders. Before Jarvis
stops, this file must hold everything a fresh session needs: `jarvis watch`
may `/clear` Jarvis after a long idle. Finished notes go to `jarvis log`,
not here.

Jarvis session: <terminal id — `handoffs/bin/jarvis start` writes it>
Usage band: <green | amber | red> — `handoffs/bin/jarvis status` writes it from the statusline reading

## Questions for the user
<!-- - <date> · <slug> · Q1 …  (batched from worker handoffs; remove when answered and passed back) -->

## Running workers
<!-- `jarvis spawn` adds: - <date HH:MM> · claude/claude-opus-5-5 high · term <id> · handoffs/briefs/<file>.md -->
<!-- `jarvis merge` removes the line -->

## Waiting on Jarvis
<!-- - handoff to review: handoffs/<file>.md · migration to apply · release to cut -->

## To-do
<!-- - next things to brief, in order; briefs queued behind the Claude cap go here -->
- Audit AutoDM + OpenReply (PRD §14, §21.1–2) → ADR in `docs/adr/0001-*.md`: fork vs smaller build
- Scaffold: Next.js App Router + TS strict + Tailwind/shadcn + Drizzle/Postgres + Vitest + Playwright + Docker compose; then set the heavy-suite lock wrappers
- Phase 0 spike: OAuth + signed webhook + private reply PoC; live test is the user's (needs Meta app, test + non-tester + non-follower accounts)
- Phase 1 core backend → Phase 2 dashboard → Phase 3 hardening → Phase 4 OSS release (PRD §15)
- Keep `docs/PROGRESS.md` (PRD §21.11) current at every merge
