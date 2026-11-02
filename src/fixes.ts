import { createHmac, randomBytes } from "node:crypto";
import { todayUtc } from "./checks.ts";
import type { Issue } from "./checks.ts";
import type { ArchiveReason, BookingRow, Db, EventRow } from "./db.ts";

// ---------- Types ----------

/** One small change. Bookings are never deleted — only archived, moved or waitlisted. */
export type Change =
  | { op: "archive_booking"; bookingId: number; reason: ArchiveReason }
  /** Same event, different time slot. */
  | { op: "move_booking"; bookingId: number; customerId: number; fromSlot: string; toSlot: string }
  /** To another event in the same city (used for overbooked events). */
  | { op: "move_to_event"; bookingId: number; customerId: number; fromEventId: number; toEventId: number; toSlot: string }
  /** No place found anywhere: the booking waits for a free place. */
  | { op: "waitlist_booking"; bookingId: number; customerId: number; eventId: number };

/**
 * A proposed fix. It deliberately does NOT contain the confirmation code: the proposal goes to
 * the AI, the code goes only to the human (decided 4.11).
 */
export interface FixProposal {
  issue: Issue;
  /** false = no safe automatic fix; a human must handle it. `changes` is then empty. */
  fixable: boolean;
  /** Plain-English description of what would happen. Contains no emails or phone numbers. */
  summary: string;
  changes: Change[];
}

export type ApplyResult =
  | { status: "dry_run"; changes: Change[]; summary: string }
  | { status: "rejected"; reason: "not_fixable" | "wrong_confirmation_code" }
  | { status: "applied"; changes: Change[]; auditLogIds: number[] };

export interface ApplyOptions {
  /** Default true: only report what would change. Set to false to really apply. */
  dryRun?: boolean;
  /** The code the human was shown for this exact proposal. */
  confirmationCode?: string;
  /** The secret the code was made with. Required to apply. */
  secret?: Uint8Array;
}

/** Thrown when a change can't be applied (e.g. the data changed since the proposal). Nothing is kept. */
export class FixError extends Error {
  override name = "FixError";
}

/** Changes that affect a customer's appointment: those customers get a message draft (Wed). */
export function needsCustomerMessage(change: Change): boolean {
  return change.op === "move_booking" || change.op === "move_to_event" || change.op === "waitlist_booking";
}

// ---------- Confirmation code ----------

/** A fresh random secret. Keep it in memory only (e.g. for the lifetime of the MCP server). */
export function newCodeSecret(): Uint8Array {
  return randomBytes(32);
}

/** JSON with object keys sorted, so the same proposal always gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * A 6-character code for one exact proposal (its issue + changes).
 * It is an HMAC — a hash mixed with a secret key — so changing anything in the proposal gives a
 * different code, and nobody who only sees the proposal (like the AI) can compute the code.
 */
export function confirmationCode(fix: Pick<FixProposal, "issue" | "changes">, secret: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(canonicalJson({ issue: fix.issue, changes: fix.changes }))
    .digest("hex")
    .slice(0, 6)
    .toUpperCase();
}

// ---------- proposeFix: read-only ----------

type ActiveBooking = Pick<BookingRow, "id" | "event_id" | "customer_id" | "slot" | "created_at">;

const ACTIVE = "archived_at IS NULL AND waitlisted_at IS NULL";

/** Active bookings with these ids, oldest first (the one made first is the one we keep). */
function bookingsOldestFirst(db: Db, bookingIds: readonly number[]): ActiveBooking[] {
  return db
    .prepare(
      `SELECT id, event_id, customer_id, slot, created_at FROM bookings
        WHERE ${ACTIVE} AND id IN (SELECT value FROM json_each(?))
        ORDER BY created_at, id`,
    )
    .all(JSON.stringify(bookingIds)) as ActiveBooking[];
}

/** Slots of an event that no active booking uses, in time order. */
function freeSlots(db: Db, eventId: number): string[] {
  const event = db.prepare("SELECT time_slots FROM events WHERE id = ?").get(eventId) as Pick<EventRow, "time_slots"> | undefined;
  if (!event) return [];
  const used = new Set(
    (db.prepare(`SELECT slot FROM bookings WHERE event_id = ? AND ${ACTIVE}`).all(eventId) as { slot: string }[]).map((r) => r.slot),
  );
  return (JSON.parse(event.time_slots) as string[]).filter((s) => !used.has(s));
}

function proposal(issue: Issue, summary: string, changes: Change[]): FixProposal {
  return { issue, fixable: changes.length > 0, summary, changes };
}

/** Describes how to fix one issue. Only reads from the database — never changes it. */
export function proposeFix(db: Db, issue: Issue, options: { today?: string } = {}): FixProposal {
  const today = options.today ?? todayUtc();
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
      // Earliest free slots first (decided 4.11). The moved customers get a message.
      const changes: Change[] = movers.map((b, i) => ({
        op: "move_booking",
        bookingId: b.id,
        customerId: b.customer_id,
        fromSlot: b.slot,
        toSlot: free[i] as string,
      }));
      return proposal(
        issue,
        `Slot ${issue.slot} of event ${issue.eventId} has ${movers.length + 1} customers. Keep booking ${keep.id} (made first) there; ${movers
          .map((b, i) => `move booking ${b.id} to ${free[i]}`)
          .join(", ")}. The moved customer(s) get a message.`,
        changes,
      );
    }

    case "past_or_cancelled_event": {
      if (bookingsOldestFirst(db, [issue.bookingId]).length === 0) {
        return proposal(issue, "Nothing to fix any more: the booking is no longer active.", []);
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

    case "overbooked_event":
      return proposeOverbookedFix(db, issue, today);
  }
}

/**
 * Overbooked (decided 4.11): never archive these customers. The bookings made last are the ones
 * over the limit; each moves to the next event in the same city that still has a place, a free
 * slot and doesn't already have this customer. If there is none, the booking goes on the waitlist.
 */
function proposeOverbookedFix(db: Db, issue: Extract<Issue, { type: "overbooked_event" }>, today: string): FixProposal {
  const active = db
    .prepare(`SELECT id, customer_id FROM bookings WHERE event_id = ? AND ${ACTIVE} ORDER BY created_at DESC, id DESC`)
    .all(issue.eventId) as { id: number; customer_id: number }[];
  // The newest bookings are over the limit; handle the earliest of those first so it gets the first free place.
  const movers = active.slice(0, Math.max(0, active.length - issue.capacity)).reverse();
  if (movers.length === 0) return proposal(issue, "Nothing to fix any more: the event is within capacity.", []);

  // Later events in the same city that haven't happened and aren't cancelled, soonest first.
  const targets = (
    db
      .prepare(
        `SELECT e.id, e.date, e.time_slots, e.capacity, COUNT(b.id) AS booked
           FROM events e
           LEFT JOIN bookings b ON b.event_id = e.id AND b.archived_at IS NULL AND b.waitlisted_at IS NULL
          WHERE e.city = ? AND e.status = 'scheduled' AND e.date > ? AND e.date >= ? AND e.id <> ?
          GROUP BY e.id
          ORDER BY e.date, e.id`,
      )
      .all(issue.city, issue.date, today, issue.eventId) as Array<{ id: number; date: string; time_slots: string; capacity: number; booked: number }>
  ).map((t) => ({
    ...t,
    places: t.capacity - t.booked,
    free: freeSlots(db, t.id),
    customers: new Set(
      (db.prepare(`SELECT customer_id FROM bookings WHERE event_id = ? AND ${ACTIVE}`).all(t.id) as { customer_id: number }[]).map(
        (r) => r.customer_id,
      ),
    ),
  }));

  const changes: Change[] = [];
  const notes: string[] = [];
  for (const m of movers) {
    const target = targets.find((t) => t.places > 0 && t.free.length > 0 && !t.customers.has(m.customer_id));
    if (target) {
      const toSlot = target.free.shift() as string; // remember it's taken for the next mover
      target.places--;
      target.customers.add(m.customer_id);
      changes.push({ op: "move_to_event", bookingId: m.id, customerId: m.customer_id, fromEventId: issue.eventId, toEventId: target.id, toSlot });
      notes.push(`move booking ${m.id} to event ${target.id} (${target.date} ${toSlot})`);
    } else {
      changes.push({ op: "waitlist_booking", bookingId: m.id, customerId: m.customer_id, eventId: issue.eventId });
      notes.push(`put booking ${m.id} on the waitlist (no later ${issue.city} event has room)`);
    }
  }
  return proposal(
    issue,
    `Event ${issue.eventId} (${issue.city} ${issue.date}) has ${movers.length} booking(s) over its capacity of ${issue.capacity}: ${notes.join("; ")}. Nobody is archived; each customer gets a message.`,
    changes,
  );
}

// ---------- applyFix: the only function that changes data ----------

/**
 * Applies a proposal. Safe by default:
 *  - dry run unless `dryRun: false` is given;
 *  - refuses unless `confirmationCode` is the code for this exact proposal (made with `secret`);
 *  - all changes and their audit_log rows run in ONE transaction: if anything fails, none of it is kept.
 */
export function applyFix(db: Db, fix: FixProposal, options: ApplyOptions = {}): ApplyResult {
  const dryRun = options.dryRun ?? true;
  if (!fix.fixable || fix.changes.length === 0) return { status: "rejected", reason: "not_fixable" };
  if (dryRun) return { status: "dry_run", changes: fix.changes, summary: fix.summary };
  // Recomputed from the proposal itself, so a proposal edited after the code was shown is refused.
  if (!options.secret || options.confirmationCode !== confirmationCode(fix, options.secret)) {
    return { status: "rejected", reason: "wrong_confirmation_code" };
  }

  // Every statement re-checks that the data still looks as the proposal expected.
  // If it doesn't, 0 rows change and the whole fix is rolled back below.
  const statements = {
    archive_booking: db.prepare(
      `UPDATE bookings SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), archive_reason = @reason
        WHERE id = @bookingId AND ${ACTIVE}`,
    ),
    // Only if the booking is still in fromSlot and toSlot is a real, still-free slot of that event.
    move_booking: db.prepare(
      `UPDATE bookings SET slot = @toSlot
        WHERE id = @bookingId AND customer_id = @customerId AND ${ACTIVE} AND slot = @fromSlot
          AND @toSlot IN (SELECT value FROM json_each((SELECT time_slots FROM events WHERE id = bookings.event_id)))
          AND NOT EXISTS (SELECT 1 FROM bookings o WHERE o.event_id = bookings.event_id AND o.slot = @toSlot
                             AND o.archived_at IS NULL AND o.waitlisted_at IS NULL)`,
    ),
    // Only if the target is scheduled, has a place, toSlot is free there and the customer isn't booked there yet.
    move_to_event: db.prepare(
      `UPDATE bookings SET event_id = @toEventId, slot = @toSlot
        WHERE id = @bookingId AND customer_id = @customerId AND event_id = @fromEventId AND ${ACTIVE}
          AND EXISTS (SELECT 1 FROM events t
                       WHERE t.id = @toEventId AND t.status = 'scheduled'
                         AND @toSlot IN (SELECT value FROM json_each(t.time_slots))
                         AND (SELECT COUNT(*) FROM bookings o WHERE o.event_id = t.id
                                AND o.archived_at IS NULL AND o.waitlisted_at IS NULL) < t.capacity)
          AND NOT EXISTS (SELECT 1 FROM bookings o WHERE o.event_id = @toEventId
                             AND o.archived_at IS NULL AND o.waitlisted_at IS NULL
                             AND (o.slot = @toSlot OR o.customer_id = @customerId))`,
    ),
    waitlist_booking: db.prepare(
      `UPDATE bookings SET waitlisted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = @bookingId AND customer_id = @customerId AND event_id = @eventId AND ${ACTIVE}`,
    ),
  };
  const audit = db.prepare("INSERT INTO audit_log (action, details) VALUES (?, ?)");

  // db.transaction() wraps the function in BEGIN … COMMIT. If the function throws, better-sqlite3
  // runs ROLLBACK instead, so every UPDATE and audit row made so far is undone, then re-throws the error.
  const run = db.transaction((): number[] => {
    const auditIds: number[] = [];
    for (const change of fix.changes) {
      const result = statements[change.op].run(change);
      if (result.changes !== 1) {
        throw new FixError(`Change ${JSON.stringify(change)} no longer applies — the data changed. Run the checks and propose again.`);
      }
      // The code itself is never stored: the audit row records what changed and who must be told.
      const details = { issueType: fix.issue.type, change, needsMessage: needsCustomerMessage(change) };
      auditIds.push(Number(audit.run(change.op, JSON.stringify(details)).lastInsertRowid));
    }
    return auditIds;
  });

  return { status: "applied", changes: fix.changes, auditLogIds: run() };
}
