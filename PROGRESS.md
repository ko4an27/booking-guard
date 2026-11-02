# Progress

Deadline: Kultakiertue application — submit Thu 5.11 (Fri 6.11 = buffer)

## Plan
- [x] Mon 2.11 — setup: repo, CLAUDE.md, package.json, TypeScript, vitest, first commit
- [x] Mon 2.11 — database schema + `seed` with deliberate errors
- [ ] Tue 3.11 — 5 SQL checks + tests (each finds exactly the seeded errors, no false positives)
- [ ] Tue 3.11 — `proposeFix` / `applyFix` with transaction, rollback test, dry-run, confirmation code
- [ ] Wed 4.11 — MCP server: `list_issues`, `propose_fix`, `apply_fix`; connect to Claude Code
- [ ] Wed 4.11 — customer message drafts (FI/EN, files only) + skill "morning booking check"
- [ ] Thu 5.11 — README ("How it stays reliable"), GitHub Actions CI, GIF demo
- [ ] Thu 5.11 — CV + cover letter, submit application

## Done
- Project setup: package.json (ESM), strict tsconfig, vitest, better-sqlite3, src/ tests/ drafts/, smoke test passing (2/2), typecheck clean.
- Schema (`src/db.ts`): events, customers, bookings, audit_log — STRICT tables with CHECK constraints and foreign keys.
- `npm run seed`: 40 events in 8 cities, 331 customers, 513 bookings; seeded errors: 12 duplicates, 9 double-booked slots, 15 bookings on past/cancelled events (7 + 8), 11 bad contacts, 4 overbooked events. Counts in `tests/expected.json`. 35 tests passing.

## Next
- Merge the "Schema and seed" PR.
- Tue 3.11: the 5 SQL checks, each tested against `tests/expected.json`.

## Open questions
- "Past event" = event date before today (UTC). Should a booking for a past event count as a problem even if the event really happened? For now: yes, as CLAUDE.md says.
- Seed dates are relative to the day you run it: re-run `npm run seed` before a demo so "future" events are still in the future.
- `seed` / `check` / `mcp` scripts from CLAUDE.md are not in package.json yet — they'll be added with the code they run.
