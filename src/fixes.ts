import { createHash } from "node:crypto";
import type { Issue } from "./checks.ts";
import type { ArchiveReason, BookingRow, Db, EventRow } from "./db.ts";

// ---------- Types ----------

/** One small, reversible change. Bookings are never deleted — only archived or moved. */
export type Change =
  | { op: "archive_booking"; bookingId: number; reason: ArchiveReason }
  | { op: "move_booking"; bookingId: number; fromSlot: string; toSlot: string };

export interface FixProposal {
  issue: Issue;
  /** false = no safe automatic fix; a human must handle it. `changes` is then empty. */
  fixable: boolean;
  /** Plain-English description of what would happen. Contains no emails or phone numbers. */
  summary: string;
  changes: Change[];
  /** Fingerprint of `changes`. applyFix only runs if it is given this exact code. */
  confirmationCode: string;
}

export type ApplyResult =
  | { status: "dry_run"; changes: Change[]; summary: string }
  | { status: "rejected"; reason: "not_fixable" | "wrong_confirmation_code" }
  | { status: "applied"; changes: Change[]; auditLogIds: number[] };

export interface ApplyOptions {
  /** Default true: only report what would change. Set to false to really apply. */
  dryRun?: boolean;
  confirmationCode?: string;
}

/** Thrown when a change can't be applied (e.g. the data changed since the proposal). Nothing is kept. */
export class FixError extends Error {
  override name = "FixError";
}

// ---------- Confirmation code ----------

/**
 * A 6-character fingerprint (SHA-256) of the exact list of changes.
 * Any edit to the changes gives a different code, so a code confirms one specific proposal only.
 */
export function confirmationCode(changes: readonly Change[]): string {
  return createHash("sha256").update(JSON.stringify(changes)).digest("hex").slice(0, 6).toUpperCase();
}

// ---------- proposeFix: read-only ----------

type ActiveBooking = Pick<BookingRow, "id" | "event_id" | "slot" | "created_at">;

/** Active bookings with these ids, oldest first (the one made first is the one we keep). */
function bookingsOldestFirst(db: Db, bookingIds: readonly number[]): ActiveBooking[] {
  const rows = db
    .prepare(
      `SELECT id, event_id, slot, created_at FROM bookings
        WHERE archived_at IS NULL AND id IN (SELECT value FROM json_each(?))
        ORDER BY created_at, id`,
    )
    .all(JSON.stringify(bookingIds)) as ActiveBooking[];
  return rows;
}

/** Slots of an event that no active booking uses, in time order. */
function freeSlots(db: Db, eventId: number): string[] {
  const event = db.prepare("SELECT time_slots FROM events WHERE id = ?").get(eventId) as Pick<EventRow, "time_slots"> | undefined;
  if (!event) return [];
  const used = new Set(
    (db.prepare("SELECT slot FROM bookings WHERE event_id = ? AND archived_at IS NULL").all(eventId) as { slot: string }[]).map(
      (r) => r.slot,
    ),
  );
  return (JSON.parse(event.time_slots) as string[]).filter((s) => !used.has(s));
}

function proposal(issue: Issue, summary: string, changes: Change[]): FixProposal {
  return { issue, fixable: changes.length > 0, summary, changes, confirmationCode: confirmationCode(changes) };
}

/** Describes how to fix one issue. Only reads from the database — never changes it. */
export function proposeFix(db: Db, issue: Issue): FixProposal {
  switch (issue.type) {
    case "duplicate_booking": {
      const [keep, ...extra] = bookingsOldestFirst(db, issue.bookingIds);
      if (!keep || extra.length === 0) return proposal(issue, "Nothing to fix any more: the duplicate is already gone.", []);
      return proposal(
        issue,
        `Customer ${issue.customerId} booked event ${issue.eventId} ${extra.length + 1} times. Keep booking ${keep.id} (made first), archive ${extra.map((b) => b.id).join(", ")}.`,
        extra.map((b) => ({ op: "archive_booking", bookingId: b.id, reason: "duplicate" })),
      );
    }

    case "double_booked_slot": {
      const [keep, ...movers] = bookingsOldestFirst(db, issue.bookingIds);
      if (!keep || movers.length === 0) return proposal(issue, "Nothing to fix any more: the slot is no longer shared.", []);
      const free = freeSlots(db, issue.eventId);
      if (free.length < movers.length) {
        return proposal(issue, `Slot ${issue.slot} of event ${issue.eventId} is shared, but there are not enough free slots to move people to. Needs a human.`, []);
      }
      const changes: Change[] = movers.map((b, i) => ({ op: "move_booking", bookingId: b.id, fromSlot: b.slot, toSlot: free[i] as string }));
      return proposal(
        issue,
        `Slot ${issue.slot} of event ${issue.eventId} has ${movers.length + 1} customers. Keep booking ${keep.id} (made first) there; ${changes
          .map((c) => (c.op === "move_booking" ? `move booking ${c.bookingId} to ${c.toSlot}` : ""))
          .join(", ")}.`,
        changes,
      );
    }

    case "past_or_cancelled_event": {
      if (bookingsOldestFirst(db, [issue.bookingId]).length === 0) {
        return proposal(issue, "Nothing to fix any more: the booking is already archived.", []);
      }
      // A past booking is history: archive it, never delete (decided 3.11).
      const reason: ArchiveReason = issue.reasons.includes("cancelled") ? "cancelled_event" : "past_event";
      return proposal(
        issue,
        `Booking ${issue.bookingId} is for event ${issue.eventId} (${issue.city} ${issue.date}), which is ${issue.reasons.join(" and ")}. Archive the booking (it is kept, not deleted).`,
        [{ op: "archive_booking", bookingId: issue.bookingId, reason }],
      );
    }

    case "bad_contact":
      // Contact data can't be guessed. A human has to find the right details.
      return proposal(
        issue,
        `Customer ${issue.customerId} has ${issue.problems.join(", ")}. This can't be fixed automatically: correct the contact details by hand.`,
        [],
      );

    case "overbooked_event": {
      // The bookings made last are the ones over the limit (duplicates count toward capacity — decided 3.11).
      const active = db
        .prepare("SELECT id FROM bookings WHERE event_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id DESC")
        .all(issue.eventId) as { id: number }[];
      const rows = active.slice(0, Math.max(0, active.length - issue.capacity));
      if (rows.length === 0) return proposal(issue, "Nothing to fix any more: the event is within capacity.", []);
      const ids = rows.map((r) => r.id).sort((a, b) => a - b);
      return proposal(
        issue,
        `Event ${issue.eventId} (${issue.city} ${issue.date}) has ${rows.length} booking(s) over its capacity of ${issue.capacity}. Archive the most recent: ${ids.join(", ")}.`,
        ids.map((id) => ({ op: "archive_booking", bookingId: id, reason: "overbooked" })),
      );
    }
  }
}

// ---------- applyFix: the only function that changes data ----------

/**
 * Applies a proposal. Safe by default:
 *  - dry run unless `dryRun: false` is given;
 *  - refuses unless `confirmationCode` matches the proposal's changes;
 *  - all changes and their audit_log rows run in ONE transaction: if anything fails, none of it is kept.
 */
export function applyFix(db: Db, fix: FixProposal, options: ApplyOptions = {}): ApplyResult {
  const dryRun = options.dryRun ?? true;
  if (!fix.fixable || fix.changes.length === 0) return { status: "rejected", reason: "not_fixable" };
  if (dryRun) return { status: "dry_run", changes: fix.changes, summary: fix.summary };
  // Recomputed from the changes themselves, so editing a proposal's changes invalidates its old code.
  if (options.confirmationCode !== confirmationCode(fix.changes)) {
    return { status: "rejected", reason: "wrong_confirmation_code" };
  }

  const archive = db.prepare(
    `UPDATE bookings SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), archive_reason = @reason
      WHERE id = @bookingId AND archived_at IS NULL`,
  );
  // Moves only if the booking is still in fromSlot and toSlot is a real, still-free slot of that event.
  const move = db.prepare(
    `UPDATE bookings SET slot = @toSlot
      WHERE id = @bookingId AND archived_at IS NULL AND slot = @fromSlot
        AND @toSlot IN (SELECT value FROM json_each((SELECT time_slots FROM events WHERE id = bookings.event_id)))
        AND NOT EXISTS (SELECT 1 FROM bookings o
                         WHERE o.event_id = bookings.event_id AND o.slot = @toSlot AND o.archived_at IS NULL)`,
  );
  const audit = db.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)");

  // db.transaction() wraps the function in BEGIN … COMMIT. If the function throws, better-sqlite3
  // runs ROLLBACK instead, so every UPDATE and audit row made so far is undone, then re-throws the error.
  const run = db.transaction((): number[] => {
    const auditIds: number[] = [];
    for (const change of fix.changes) {
      const result = change.op === "archive_booking" ? archive.run(change) : move.run(change);
      // 0 rows changed = the data no longer looks like the proposal expected (stale proposal).
      if (result.changes !== 1) {
        throw new FixError(`Change ${JSON.stringify(change)} no longer applies — the data changed. Run the checks and propose again.`);
      }
      const details = { issueType: fix.issue.type, change, confirmationCode: options.confirmationCode };
      auditIds.push(Number(audit.run(change.op, JSON.stringify(details)).lastInsertRowid));
    }
    return auditIds;
  });

  return { status: "applied", changes: fix.changes, auditLogIds: run() };
}
