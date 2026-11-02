# Booking Guard

An AI agent that checks a database of customer bookings (gold-valuation events in Finnish cities),
finds problems, proposes fixes and drafts customer messages. It never changes data without explicit
human confirmation. All data is fake (`npm run seed`).

## Commands

| Command | What it does |
|---|---|
| `npm run seed` | Recreate `data/booking-guard.db` with ~500 fake bookings and deliberate errors of every type |
| `npm run check` | Print the issues found (read-only; emails and phones masked) |
| `npm run mcp` | Start the MCP server (Claude Code starts it itself via `.mcp.json`) |
| `npm test` | Run all tests |

## MCP tools

- `list_issues({ city? })`: runs the 5 checks. Read-only.
- `propose_fix({ issueId })`: describes a fix and changes nothing. The confirmation code goes to the human only.
- `apply_fix({ proposalId, confirmationCode, dryRun })`: dry run by default. It needs the human's code and runs in one transaction with an `audit_log` entry.

## Safety model: what is guaranteed, and what is defense in depth

**The hard guarantee is the Claude Code permission prompt on `apply_fix`.**
`.claude/settings.json` contains `permissions.ask: ["mcp__booking-guard__apply_fix"]`, so Claude Code
asks the human every time before `apply_fix` runs. Bash must stay on "ask" in this project too.
An AI that may run shell commands without asking could change the database directly
(with `node` or `sqlite3`) and never call `apply_fix` at all.

**The confirmation code is defense in depth, not a hard guarantee.**
- The code is never part of a tool result, so the AI doesn't get it through the MCP conversation.
- It is shown on the human's terminal (`/dev/tty`). Without a terminal, for example in Claude Code on the web,
  it is written to `pending/CONFIRM-<proposalId>.txt` (git-ignored, readable by the owner only).
  That file is on the same machine, so **an AI with shell access could read it.** The tools tell the AI not to,
  but that is an instruction, not a lock.
- What the code does guarantee: it is tied to one exact proposal. It is an HMAC of that proposal, made with a secret
  that exists only in the server's memory. A changed fix needs a new code, an old code stops working when
  the issue is proposed again, and nobody can compute a code from the proposal alone.

**Other protections**
- `apply_fix` looks up the proposal **on the server by id**. Proposal data sent by the AI is never trusted.
- A proposal can be used once, expires after 15 minutes, and locks after 3 wrong codes.
- All changes and their `audit_log` rows run in one transaction. Any error rolls everything back.
- Bookings are never deleted, only archived, moved or waitlisted.
- Emails and phone numbers are masked in every tool result and in printed output.
