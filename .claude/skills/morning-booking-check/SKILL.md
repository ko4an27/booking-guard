---
name: morning-booking-check
description: Daily Booking Guard routine. Re-checks the bookings database, summarizes the issues by city, proposes fixes, applies them ONLY after the human approves each one, writes customer message drafts and ends with a summary. Use when the user asks for the morning booking check, the daily check, or a booking check for one city (e.g. "morning check for Turku").
---

# Morning booking check

The daily routine for Booking Guard. It uses only the `booking-guard` MCP tools:
`list_issues`, `propose_fix`, `apply_fix`, `draft_messages`.

If the user names a city, pass it as `city` everywhere. Otherwise check all cities.

## Ground rules (always)

- **Never change data on your own.** Every `apply_fix` call needs the human's approval in this
  conversation, plus the confirmation code the human gives you.
- **Never read `pending/`** (the confirmation code files). The human reads them and tells you the code.
- **Never change the database any other way**: no `sqlite3`, `node -e` or scripts. If a tool is
  missing or fails, stop and tell the human. Don't work around it.
- **Never send anything.** Customer messages are draft files in `drafts/` only.
- Never write a full email address or phone number in your replies; tool results are already masked.

## Steps

1. **Re-check.** Call `list_issues` (with `city` if given). Always start from fresh results,
   never from an earlier run.

2. **Summarize by city.** For each city: the number of issues per type (duplicate bookings,
   double-booked slots, past/cancelled-event bookings, bad contact data, overbooked events).
   Then a total.

3. **Propose fixes.** Call `propose_fix` for each issue. For each proposal, show:
   `proposalId`, the issue, the plain-English summary and the number of changes.
   Mark issues that can't be fixed automatically (bad contact data) as "needs a human".

4. **STOP and ask.** Do not call `apply_fix` yet. Ask the human which proposals to apply, and to
   give the confirmation code for each, from their terminal or `pending/CONFIRM-<proposalId>.txt`.
   Wait for the answer.

5. **Apply one fix at a time, only the approved ones.** For each approved proposal:
   1. `apply_fix` with `dryRun: true` (the default), and show what will change;
   2. `apply_fix` with the human's code and `dryRun: false` (Claude Code shows a permission prompt);
   3. report the result before moving on to the next one.

   If a proposal is rejected, expired or failed: don't retry on your own. Report it, and offer to
   propose it again (Step 3) for that issue.

6. **Write message drafts.** Call `draft_messages` once after the fixes. List the draft files
   created (customer id + file name). Say clearly that nothing was sent.

7. **Final summary.** Show:
   - issues found per city (from Step 2);
   - fixes applied, and fixes rejected, failed or skipped, with the reason;
   - issues that still need a human (e.g. bad contact data);
   - draft files written;
   - a fresh `list_issues` count, to show what is left.

## When to STOP and ask the human

Stop, explain, and wait for an answer when any of these happens:

- **Any data change.** Before every `apply_fix` with `dryRun: false`, the human must have approved
  that exact proposal and given its code. Approval for one proposal does not cover another.
- **An unclear issue.** The issue doesn't fit the five known types, a proposal looks wrong or
  surprising, or two proposals touch the same booking or event.
- **More than 20 changes at once.** If the approved proposals add up to more than 20 changes in total
  (count the `changes` in each proposal), stop and ask before applying any of them. Suggest doing it
  city by city.
- **Any error.** A tool error, `status: "failed"`, `"rejected"` or `"expired"`, a missing tool, or a
  result you don't understand. Report it as it is; never work around it.
