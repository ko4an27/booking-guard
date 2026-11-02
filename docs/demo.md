# Demo: morning booking check for Turku

A real run of the `morning-booking-check` skill on 2 November 2026, in **Claude Code on the web**,
against the seeded demo database. These are the actual tool results, shortened. All contact data
is masked, as the tools return it. Confirmation codes are replaced by `••••••`: they were single-use
and have been spent.

The human asked: *"Run the morning booking check for Turku."*

## 1. Re-check

`list_issues({ city: "Turku" })`

```json
{
  "today": "2026-11-02",
  "city": "Turku",
  "total": 3,
  "counts": { "duplicate_booking": 3 },
  "issues": [
    { "issueId": "duplicate_booking:27:93",  "eventId": 27, "date": "2026-12-12", "customerId": 93,  "email": "j***@example.com", "bookingIds": [187, 291] },
    { "issueId": "duplicate_booking:30:180", "eventId": 30, "date": "2026-12-19", "customerId": 180, "email": "e***@example.com", "bookingIds": [12, 228] },
    { "issueId": "duplicate_booking:30:254", "eventId": 30, "date": "2026-12-19", "customerId": 254, "email": "e***@example.com", "bookingIds": [152, 266] }
  ]
}
```

## 2. Summary by city

| City | Duplicates | Double-booked | Past/cancelled | Bad contacts | Overbooked | Total |
|---|---|---|---|---|---|---|
| Turku | 3 | 0 | 0 | 0 | 0 | **3** |

## 3. Proposals

`propose_fix({ issueId })` for each issue. Nothing is changed. Each result says the code was
*"shown to the human only (their terminal, or pending/CONFIRM-&lt;id&gt;.txt) — not included here"*.

| Proposal | Summary | Changes |
|---|---|---|
| `P-3ca80a75` | Customer 93 booked event 27 2 times. Keep booking 187 (made first), archive 291. | 1 |
| `P-69b55783` | Customer 180 booked event 30 2 times. Keep booking 12 (made first), archive 228. | 1 |
| `P-405f7dcb` | Customer 254 booked event 30 2 times. Keep booking 152 (made first), archive 266. | 1 |

The server wrote the three codes to `pending/CONFIRM-P-3ca80a75.txt`, `…P-69b55783.txt` and `…P-405f7dcb.txt`.

## 4. Stop and ask

Claude stopped and asked which proposals to apply and for their codes. It noted that two proposals
touch the same event (30) but different bookings, so they don't conflict.

**Human:** *"Apply all three proposals. On Claude Code web I can't open files myself, so run
`cat pending/CONFIRM-P-*.txt` — I'll approve that command in the permission prompt."*

> **Web-session limitation, recorded honestly.** In Claude Code on the web there is no terminal, and
> the human could not open the `pending/` files. So the human told Claude to read them with `cat` and
> approved that command in the permission prompt. **Claude therefore saw the codes.** In this setup the
> code adds no secrecy. What protected the data was the human's explicit approval of the `cat` command
> and of every `apply_fix` call. This is exactly the limitation described in the README: the permission
> prompt is the hard guarantee, and the confirmation code is defense in depth. It does its job on a
> local terminal (`/dev/tty`) or when the human can open the file themselves.

## 5. Apply, one fix at a time

For each proposal: a dry run, then the real call. The human approved each real `apply_fix` in Claude
Code's permission prompt.

| Proposal | Dry run | Apply (`dryRun: false`, human's code) | audit_log |
|---|---|---|---|
| `P-3ca80a75` | `dry_run`: archive booking 291 | `applied` | row 2 |
| `P-69b55783` | `dry_run`: archive booking 228 | `applied` | row 3 |
| `P-405f7dcb` | `dry_run`: archive booking 266 | `applied` | row 4 |

Example result:

```json
{
  "proposalId": "P-3ca80a75",
  "status": "applied",
  "changes": [{ "op": "archive_booking", "bookingId": 291, "reason": "duplicate" }],
  "auditLogIds": [2]
}
```

After each apply, the server deleted that proposal's code file: `pending/` ended up empty.
The archived bookings still exist (`archived_at` and `archive_reason = 'duplicate'`). Nothing was deleted.

## 6. Message drafts

**Not run in this session.** `draft_messages` had been added to the server after this session started.
The MCP server process was restarted with the new code, but the session kept its original tool list,
so the tool could not be called. Following the skill's rule ("a missing tool: stop and report, never work
around it"), Claude reported this instead of calling the function another way.

It would not have produced anything here anyway: archiving a duplicate doesn't change the customer's
appointment, so these changes have `needsMessage: false`. Moved and waitlisted customers do get drafts;
the tests (`tests/messages.test.ts`) cover them.

## 7. Final summary

- **Issues found:** Turku 3 (3 duplicate bookings).
- **Fixes applied:** 3 of 3 (bookings 291, 228 and 266 archived as duplicates; `audit_log` rows 2–4).
- **Rejected / failed / skipped:** none.
- **Still needs a human:** nothing in Turku.
- **Draft files written:** none (no change needed a message; and `draft_messages` was not available, see step 6).
- **Fresh check:** `list_issues({ city: "Turku" })` → `total: 0`. All cities: 48 issues left (was 51).
