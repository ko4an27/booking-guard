# Progress

Deadline: Kultakiertue application — submit Thu 5.11 (Fri 6.11 = buffer)

## Plan
- [x] Mon 2.11 — setup: repo, CLAUDE.md, package.json, TypeScript, vitest, first commit
- [x] Mon 2.11 — database schema + `seed` with deliberate errors
- [x] Tue 3.11 — 5 SQL checks + tests (each finds exactly the seeded errors, no false positives)
- [x] Tue 3.11 — `proposeFix` / `applyFix` with transaction, rollback test, dry-run, confirmation code
- [x] Wed 4.11 — MCP server: `list_issues`, `propose_fix`, `apply_fix`; connect to Claude Code
- [x] Wed 4.11 — customer message drafts (FI/EN, files only) + skill "morning booking check"
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
- Without a terminal (Claude Code on the web) the code goes to `pending/CONFIRM-<proposalId>.txt` (git-ignored, owner-only) and is removed when the proposal is used, replaced, expired or locked. README states the safety model honestly. Project `.mcp.json` loads in the cloud session (`list_issues` for Turku works). 147 tests passing.
- Message drafts (`src/messages.ts`, MCP tool `draft_messages`): one FI + EN draft per affected customer in `drafts/`, first name only, masked contact data in the header, nothing sent. `message_drafts` table makes re-runs create nothing new. Skill `.claude/skills/morning-booking-check/SKILL.md`. Demo on Turku: 3 duplicates proposed, stopped before apply. 161 tests passing.
- Packaging: README for hiring managers (Mermaid flow, quick start, checks, tools, "How it stays reliable", "Limitations"), GitHub Actions CI (Node 22: npm ci, typecheck, test) with badge, MIT LICENSE (Andrii Kochniev).
- `docs/demo.md`: real morning check on Turku in Claude Code on the web — 3 duplicates proposed, approved, applied one by one (audit_log rows 2–4); Turku now 0 issues, all cities 48. Web limitation recorded: no terminal, so the codes were read with an approved `cat`.

## Next
- Merge PR #9 (drafts + skill: PR #8 landed in its stacked base, not in main), then the packaging PR.
- Thu 5.11: GIF demo, CV + cover letter.

## Decisions
- Drafts keep the generic "Asiakaspalvelu / Customer service" signature (fine for a demo).
- Stacked PRs: always target `main` (twice a stacked PR was merged into its base branch instead of main).
- zod is OK (needed by the MCP SDK).
- No terminal → code goes to `pending/CONFIRM-<proposalId>.txt`. `apply_fix` looks up proposals on the server by id only.
- Double-booked slot = two different customers in one slot (the same customer twice = duplicate only).
- Duplicates count toward capacity.
- Past-event bookings are a problem; the fix ARCHIVES them, never deletes. (All fixes archive or move — nothing is ever deleted.)
- Confirmation code never goes back to the AI: `propose_fix` shows it only to the human; it is tied to the exact proposal, so a changed fix needs a new code. `apply_fix` stays behind a Claude Code permission prompt (never auto-allowed).
- Overbooked: never archive. Move to the next event in the same city with free capacity; if none, waitlist. Those customers get a message.
- Double-booked: move to the earliest free slot; those customers get a message.

## Open questions
- In Claude Code on the web the human can't open `pending/` files, so the code ends up readable by the AI (approved `cat`). Better human-only channel for web sessions?
- `draft_messages` wasn't callable in the demo session (tool list cached at session start). Re-run the demo with drafts (e.g. on a city with moves) in a fresh session?
- The pending/ file is readable by an AI with shell access: the code is defense in depth; the permission prompt on `apply_fix` (and Bash on prompt) is the hard guarantee. Documented in README.
- An already running MCP server keeps its old code until the session restarts it. This session's server is from before the pending-file fallback and `draft_messages`.
- Does `disableBypassPermissionsMode` work from project settings? The docs don't say; the `ask` rule itself is documented to apply even over a user-level `allow`.
- Seed dates are relative to the day you run it: re-run `npm run seed` before a demo so "future" events are still in the future.
