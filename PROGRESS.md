# Progress

Deadline: Kultakiertue application — submit Thu 5.11 (Fri 6.11 = buffer)

## Plan
- [x] Mon 2.11 — setup: repo, CLAUDE.md, package.json, TypeScript, vitest, first commit
- [x] Mon 2.11 — database schema + `seed` with deliberate errors
- [x] Tue 3.11 — 5 SQL checks + tests (each finds exactly the seeded errors, no false positives)
- [x] Tue 3.11 — `proposeFix` / `applyFix` with transaction, rollback test, dry-run, confirmation code
- [x] Wed 4.11 — MCP server: `list_issues`, `propose_fix`, `apply_fix`; connect to Claude Code
- [ ] Wed 4.11 — customer message drafts (FI/EN, files only) + skill "morning booking check"
- [ ] Thu 5.11 — README ("How it stays reliable"), GitHub Actions CI, GIF demo
- [ ] Thu 5.11 — CV + cover letter, submit application

## Done
- Project setup: package.json (ESM), strict tsconfig, vitest, better-sqlite3, src/ tests/ drafts/, smoke test passing (2/2), typecheck clean.
- Schema (`src/db.ts`): events, customers, bookings, audit_log — STRICT tables with CHECK constraints and foreign keys.
- `npm run seed`: 40 events in 8 cities, 331 customers, 513 bookings; seeded errors: 12 duplicates, 9 double-booked slots, 15 bookings on past/cancelled events (7 + 8), 11 bad contacts, 4 overbooked events. Counts in `tests/expected.json`. 35 tests passing.
- Checks (`src/checks.ts`): 5 SQL queries (JOIN / GROUP BY) returning typed issues; find exactly the 12 / 9 / 15 / 11 / 4 seeded errors, zero on a clean database and on near-miss cases. `npm run check` prints a masked summary (`src/report.ts`, `src/mask.ts`). 82 tests passing.
- Fixes (`src/fixes.ts`): `proposeFix` (read-only) and `applyFix` (dry-run by default, confirmation code, one transaction, one audit_log row per change). Bookings are archived (`archived_at`, `archive_reason`), never deleted; checks ignore archived bookings. Rollback tested for 3 kinds of mid-fix failure. 110 tests passing.
- Fix decisions of 4.11: confirmation code is an HMAC (secret key in memory) of the exact proposal and is no longer part of the proposal or the audit_log; overbooked customers move to the next event in the same city with room, otherwise waitlist (`bookings.waitlisted_at`); moved/waitlisted customers are flagged `needsMessage` in audit_log. 119 tests passing.
- MCP server (`src/mcp-server.ts`, `npm run mcp`, `.mcp.json`): `list_issues` (optional city), `propose_fix`, `apply_fix`. Proposals are stored on the server and referenced by id; each has its own key, expires after 15 min, is single-use, is replaced by a newer proposal for the same issue, and locks after 3 wrong codes. Codes are shown to the human (/dev/tty, else stderr), never in a tool result. All results masked plus a final scrub. `apply_fix` is an `ask` rule in `.claude/settings.json`. 141 tests passing.

## Next
- Merge the "Fix decisions" PR (#5), then the MCP PR. Re-run `npm run seed` afterwards.
- Try it in Claude Code: approve the project MCP server, check where the confirmation code appears.
- Wed 4.11: message drafts for audit_log rows with `needsMessage: true`.

## Decisions
- Double-booked slot = two different customers in one slot (the same customer twice = duplicate only).
- Duplicates count toward capacity.
- Past-event bookings are a problem; the fix ARCHIVES them, never deletes. (All fixes archive or move — nothing is ever deleted.)
- Confirmation code never goes back to the AI: `propose_fix` shows it only to the human; it is tied to the exact proposal, so a changed fix needs a new code. `apply_fix` stays behind a Claude Code permission prompt (never auto-allowed).
- Overbooked: never archive. Move to the next event in the same city with free capacity; if none, waitlist. Those customers get a message.
- Double-booked: move to the earliest free slot; those customers get a message.

## Open questions
- Where does the code actually show up in Claude Code? The server writes to /dev/tty (straight to the terminal) and falls back to stderr. Not testable here (no terminal in the cloud container); check on your machine. If /dev/tty garbles the Claude Code screen, we need another human-only channel.
- The code protects the MCP path only. If Claude may run Bash with `node` or `sqlite3`, it could change the database directly; keep Bash on prompt for this project.
- Does `disableBypassPermissionsMode` work from project settings? The docs don't say; the `ask` rule itself is documented to apply even over a user-level `allow`.
- `zod` was added as a dependency: the MCP SDK needs it for tool input schemas (peer dependency). OK?
- Seed dates are relative to the day you run it: re-run `npm run seed` before a demo so "future" events are still in the future.
