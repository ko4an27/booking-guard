# Progress

Deadline: Kultakiertue application — submit Thu 5.11 (Fri 6.11 = buffer)

## Plan
- [x] Mon 2.11 — setup: repo, CLAUDE.md, package.json, TypeScript, vitest, first commit
- [x] Mon 2.11 — database schema + `seed` with deliberate errors
- [x] Tue 3.11 — 5 SQL checks + tests (each finds exactly the seeded errors, no false positives)
- [x] Tue 3.11 — `proposeFix` / `applyFix` with transaction, rollback test, dry-run, confirmation code
- [ ] Wed 4.11 — MCP server: `list_issues`, `propose_fix`, `apply_fix`; connect to Claude Code
- [ ] Wed 4.11 — customer message drafts (FI/EN, files only) + skill "morning booking check"
- [ ] Thu 5.11 — README ("How it stays reliable"), GitHub Actions CI, GIF demo
- [ ] Thu 5.11 — CV + cover letter, submit application

## Done
- Project setup: package.json (ESM), strict tsconfig, vitest, better-sqlite3, src/ tests/ drafts/, smoke test passing (2/2), typecheck clean.
- Schema (`src/db.ts`): events, customers, bookings, audit_log — STRICT tables with CHECK constraints and foreign keys.
- `npm run seed`: 40 events in 8 cities, 331 customers, 513 bookings; seeded errors: 12 duplicates, 9 double-booked slots, 15 bookings on past/cancelled events (7 + 8), 11 bad contacts, 4 overbooked events. Counts in `tests/expected.json`. 35 tests passing.
- Checks (`src/checks.ts`): 5 SQL queries (JOIN / GROUP BY) returning typed issues; find exactly the 12 / 9 / 15 / 11 / 4 seeded errors, zero on a clean database and on near-miss cases. `npm run check` prints a masked summary (`src/report.ts`, `src/mask.ts`). 82 tests passing.
- Fixes (`src/fixes.ts`): `proposeFix` (read-only) and `applyFix` (dry-run by default, confirmation code, one transaction, one audit_log row per change). Bookings are archived (`archived_at`, `archive_reason`), never deleted; checks ignore archived bookings. Rollback tested for 3 kinds of mid-fix failure. 110 tests passing.

## Next
- Merge the "Fixes" PR. Re-run `npm run seed` afterwards (new booking columns).
- Wed 4.11: MCP server with `list_issues`, `propose_fix`, `apply_fix`.

## Decisions
- Double-booked slot = two different customers in one slot (the same customer twice = duplicate only).
- Duplicates count toward capacity.
- Past-event bookings are a problem; the fix ARCHIVES them, never deletes. (All fixes archive or move — nothing is ever deleted.)

## Open questions
- MCP: the confirmation code is returned by `propose_fix`, so the AI could pass it straight to `apply_fix`. Should the code only be shown to the human (e.g. `apply_fix` behind a Claude Code permission prompt)?
- Overbooked fix archives the most recently made bookings. OK, or should those customers be moved to another event instead?
- Double-booked fix moves the later booking to the earliest free slot. Those customers will need a message (Wed drafts).
- Seed dates are relative to the day you run it: re-run `npm run seed` before a demo so "future" events are still in the future.
- `seed` / `check` / `mcp` scripts from CLAUDE.md are not in package.json yet — they'll be added with the code they run.
