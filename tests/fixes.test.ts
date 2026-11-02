import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAllChecks } from "../src/checks.ts";
import type { CheckResults, Issue } from "../src/checks.ts";
import { createSchema, openDb } from "../src/db.ts";
import type { BookingRow, Db } from "../src/db.ts";
import { applyFix, confirmationCode, FixError, needsCustomerMessage, newCodeSecret, proposeFix } from "../src/fixes.ts";
import type { Change, FixProposal } from "../src/fixes.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";

const TODAY = "2026-11-02";
const SECRET = new TextEncoder().encode("test-secret-only-for-tests");
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: new Date(`${TODAY}T12:00:00Z`) }));
});
afterEach(() => db.close());

/** Every row of every table — used to prove "the database is exactly as before". */
function snapshot(d: Db = db): Record<string, unknown[]> {
  const tables = ["events", "customers", "bookings", "audit_log"];
  return Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
}

const first = <K extends keyof CheckResults>(key: K, d: Db = db): CheckResults[K][number] => {
  const issue = runAllChecks(d, TODAY)[key][0];
  if (!issue) throw new Error(`no ${key} issue`);
  return issue;
};
const propose = (issue: Issue, d: Db = db) => proposeFix(d, issue, { today: TODAY });
const booking = (id: number, d: Db = db) => d.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow;
const count = (sql: string, d: Db = db) => (d.prepare(sql).get() as { n: number }).n;
/** Apply as the human would: with the code made for this proposal. */
const apply = (fix: FixProposal, d: Db = db) =>
  applyFix(d, fix, { dryRun: false, secret: SECRET, confirmationCode: confirmationCode(fix, SECRET) });

describe("confirmationCode", () => {
  const fix = () => propose(first("duplicateBookings"));

  it("is 6 characters and the same for the same proposal and secret", () => {
    expect(confirmationCode(fix(), SECRET)).toMatch(/^[0-9A-F]{6}$/);
    expect(confirmationCode(fix(), SECRET)).toBe(confirmationCode(fix(), SECRET));
  });

  it("does not depend on the order of keys in the proposal", () => {
    const f = fix();
    const reordered = JSON.parse(JSON.stringify({ changes: f.changes, issue: f.issue })) as FixProposal;
    expect(confirmationCode(reordered, SECRET)).toBe(confirmationCode(f, SECRET));
  });

  it("changes when the changes or the issue change", () => {
    const f = fix();
    const code = confirmationCode(f, SECRET);
    expect(confirmationCode({ ...f, changes: [{ op: "archive_booking", bookingId: 1, reason: "duplicate" }] }, SECRET)).not.toBe(code);
    expect(confirmationCode({ ...f, issue: { ...f.issue, eventId: f.issue.type === "duplicate_booking" ? 999 : 0 } as Issue }, SECRET)).not.toBe(code);
  });

  it("depends on the secret, so it can't be computed from the proposal alone", () => {
    expect(confirmationCode(fix(), SECRET)).not.toBe(confirmationCode(fix(), new TextEncoder().encode("another-secret")));
    expect(confirmationCode(fix(), newCodeSecret())).not.toBe(confirmationCode(fix(), newCodeSecret()));
  });

  it("is not part of the proposal (the proposal goes to the AI)", () => {
    const f = fix();
    expect(Object.keys(f).sort()).toEqual(["changes", "fixable", "issue", "summary"]);
    expect(JSON.stringify(f)).not.toContain(confirmationCode(f, SECRET));
  });
});

describe("proposeFix", () => {
  it("modifies nothing, for every issue in the seeded database", () => {
    const before = snapshot();
    const issues: Issue[] = Object.values(runAllChecks(db, TODAY)).flat();
    expect(issues).toHaveLength(51);
    for (const issue of issues) propose(issue);
    expect(snapshot()).toEqual(before);
  });

  it("duplicate: keeps the booking made first and archives the others", () => {
    const issue = first("duplicateBookings");
    const fix = propose(issue);
    const [keep, ...rest] = [...issue.bookingIds].sort((a, b) => booking(a).created_at.localeCompare(booking(b).created_at));
    expect(fix.changes).toEqual(rest.map((id) => ({ op: "archive_booking", bookingId: id, reason: "duplicate" })));
    expect(fix.changes.some((c) => c.bookingId === keep)).toBe(false);
  });

  it("double-booked slot: moves the later booking to the earliest free slot of the same event", () => {
    const issue = first("doubleBookedSlots");
    const change = propose(issue).changes[0];
    if (change?.op !== "move_booking") throw new Error("expected move_booking");
    expect(change.fromSlot).toBe(issue.slot);
    const slots = JSON.parse((db.prepare("SELECT time_slots FROM events WHERE id = ?").get(issue.eventId) as { time_slots: string }).time_slots) as string[];
    const used = new Set((db.prepare("SELECT slot FROM bookings WHERE event_id = ?").all(issue.eventId) as { slot: string }[]).map((r) => r.slot));
    expect(change.toSlot).toBe(slots.find((s) => !used.has(s)));
  });

  it("past or cancelled event: archives the booking (never deletes)", () => {
    const issue = first("pastOrCancelledEvents");
    expect(propose(issue).changes).toEqual([
      { op: "archive_booking", bookingId: issue.bookingId, reason: issue.reasons.includes("cancelled") ? "cancelled_event" : "past_event" },
    ]);
  });

  it("bad contact data: not fixable automatically, and no contact data in the summary", () => {
    const fix = propose(first("badContacts"));
    expect(fix.fixable).toBe(false);
    expect(fix.summary).not.toMatch(/@|\+358/);
  });

  it("overbooked: moves exactly the newest extra bookings to later events in the same city — nobody archived", () => {
    const issue = first("overbookedEvents");
    const fix = propose(issue);
    const newest = (db
      .prepare("SELECT id FROM bookings WHERE event_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(issue.eventId, issue.booked - issue.capacity) as { id: number }[]).map((r) => r.id);
    expect(fix.changes.map((c) => c.bookingId).sort()).toEqual(newest.sort());
    for (const c of fix.changes) {
      expect(c.op).toBe("move_to_event"); // the seed has later events with room in every city
      if (c.op !== "move_to_event") continue;
      const target = db.prepare("SELECT city, date, status FROM events WHERE id = ?").get(c.toEventId) as { city: string; date: string; status: string };
      expect(target.city).toBe(issue.city);
      expect(target.date > issue.date).toBe(true);
      expect(target.status).toBe("scheduled");
    }
  });
});

/** A tiny city with one overbooked event and the given later events. */
function smallCity(later: Array<{ id: number; date: string; capacity: number; status?: string; slots?: string[] }>): Db {
  const d = openDb(":memory:");
  createSchema(d);
  const ins = d.prepare("INSERT INTO events (id, city, date, time_slots, capacity, status) VALUES (?, 'Oulu', ?, ?, ?, ?)");
  ins.run(1, "2026-12-01", JSON.stringify(["10:00", "10:20", "10:40"]), 2, "scheduled");
  for (const e of later) ins.run(e.id, e.date, JSON.stringify(e.slots ?? ["10:00", "10:20"]), e.capacity, e.status ?? "scheduled");
  d.exec(`
    INSERT INTO customers (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C'), (4, 'D');
    INSERT INTO bookings (id, event_id, customer_id, slot, created_at) VALUES
      (1, 1, 1, '10:00', '2026-10-01'), (2, 1, 2, '10:20', '2026-10-02'), (3, 1, 3, '10:40', '2026-10-03');
  `);
  return d;
}

describe("overbooked: choosing where to move", () => {
  it("goes to the NEXT event with room, skipping full, cancelled and earlier ones", () => {
    const d = smallCity([
      { id: 2, date: "2026-11-20", capacity: 5 }, // earlier than the overbooked event
      { id: 3, date: "2026-12-05", capacity: 5, status: "cancelled" },
      { id: 4, date: "2026-12-08", capacity: 1 }, // full: see booking below
      { id: 5, date: "2026-12-15", capacity: 5 }, // ← expected
      { id: 6, date: "2026-12-20", capacity: 5 },
    ]);
    d.exec("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (4, 4, '10:00', '2026-10-01')");
    const fix = propose(first("overbookedEvents", d), d);
    expect(fix.changes).toEqual([{ op: "move_to_event", bookingId: 3, customerId: 3, fromEventId: 1, toEventId: 5, toSlot: "10:00" }]);
    d.close();
  });

  it("skips an event where the customer is already booked (that would be a duplicate)", () => {
    const d = smallCity([
      { id: 2, date: "2026-12-05", capacity: 5 },
      { id: 3, date: "2026-12-10", capacity: 5 },
    ]);
    d.exec("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (2, 3, '10:00', '2026-10-01')");
    const change = propose(first("overbookedEvents", d), d).changes[0];
    expect(change).toMatchObject({ op: "move_to_event", toEventId: 3 });
    d.close();
  });

  it("puts the booking on the waitlist when no later event has room", () => {
    const d = smallCity([{ id: 2, date: "2026-12-05", capacity: 5, slots: [] }]); // no slots at all
    const fix = propose(first("overbookedEvents", d), d);
    expect(fix.changes).toEqual([{ op: "waitlist_booking", bookingId: 3, customerId: 3, eventId: 1 }]);
    apply(fix, d);
    expect(booking(3, d).waitlisted_at).not.toBeNull();
    expect(booking(3, d).archived_at).toBeNull();
    expect(runAllChecks(d, TODAY).overbookedEvents).toEqual([]);
    d.close();
  });

  it("two movers never get the same place", () => {
    const d = smallCity([{ id: 2, date: "2026-12-05", capacity: 1 }, { id: 3, date: "2026-12-06", capacity: 5 }]);
    d.exec("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, 4, '10:00', '2026-10-04')"); // 4 bookings, capacity 2
    const fix = propose(first("overbookedEvents", d), d);
    expect(fix.changes).toEqual([
      { op: "move_to_event", bookingId: 3, customerId: 3, fromEventId: 1, toEventId: 2, toSlot: "10:00" },
      { op: "move_to_event", bookingId: 4, customerId: 4, fromEventId: 1, toEventId: 3, toSlot: "10:00" },
    ]);
    expect(apply(fix, d).status).toBe("applied");
    d.close();
  });
});

describe("applyFix — safe by default", () => {
  it("is a dry run by default and changes nothing, even with the right code", () => {
    const fix = propose(first("duplicateBookings"));
    const before = snapshot();
    expect(applyFix(db, fix).status).toBe("dry_run");
    expect(applyFix(db, fix, { secret: SECRET, confirmationCode: confirmationCode(fix, SECRET) }).status).toBe("dry_run");
    expect(snapshot()).toEqual(before);
  });

  it.each<[string, { secret?: Uint8Array; confirmationCode?: string }]>([
    ["no code", { secret: SECRET }],
    ["a wrong code", { secret: SECRET, confirmationCode: "000000" }],
    ["the right code but no secret", { confirmationCode: "RIGHT" }],
    ["the right code made with another secret", { secret: new TextEncoder().encode("other"), confirmationCode: "RIGHT" }],
    ["the right code in lower case", { secret: SECRET, confirmationCode: "lower" }],
  ])("with %s it changes nothing", (_label, opts) => {
    const fix = propose(first("duplicateBookings"));
    const right = confirmationCode(fix, SECRET);
    const code = opts.confirmationCode === "RIGHT" ? right : opts.confirmationCode === "lower" ? right.toLowerCase() : opts.confirmationCode;
    const before = snapshot();
    const result = applyFix(db, fix, { dryRun: false, ...(opts.secret ? { secret: opts.secret } : {}), ...(code ? { confirmationCode: code } : {}) });
    expect(result).toEqual({ status: "rejected", reason: "wrong_confirmation_code" });
    expect(snapshot()).toEqual(before);
  });

  it("a changed proposal needs a new code: the old code is refused", () => {
    const fix = propose(first("duplicateBookings"));
    const oldCode = confirmationCode(fix, SECRET);
    const changed: FixProposal = { ...fix, changes: [{ op: "archive_booking", bookingId: 1, reason: "duplicate" }] };
    const before = snapshot();
    expect(applyFix(db, changed, { dryRun: false, secret: SECRET, confirmationCode: oldCode }).status).toBe("rejected");
    expect(snapshot()).toEqual(before);
  });

  it("refuses a not-fixable proposal", () => {
    expect(apply(propose(first("badContacts")))).toEqual({ status: "rejected", reason: "not_fixable" });
  });
});

describe("applyFix — applying", () => {
  it("archives (never deletes) and writes one audit_log row per change, without the code", () => {
    const fix = propose(first("duplicateBookings"));
    const bookingsBefore = count("SELECT COUNT(*) AS n FROM bookings");
    const auditBefore = count("SELECT COUNT(*) AS n FROM audit_log");
    expect(apply(fix).status).toBe("applied");
    expect(count("SELECT COUNT(*) AS n FROM bookings")).toBe(bookingsBefore);
    for (const c of fix.changes) expect(booking(c.bookingId).archive_reason).toBe("duplicate");
    expect(count("SELECT COUNT(*) AS n FROM audit_log")).toBe(auditBefore + fix.changes.length);
    const row = db.prepare("SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 1").get() as { action: string; details: string };
    expect(row.action).toBe("archive_booking");
    expect(JSON.parse(row.details)).toEqual({ issueType: "duplicate_booking", change: fix.changes.at(-1), needsMessage: false });
    expect(row.details).not.toContain(confirmationCode(fix, SECRET));
  });

  it("marks moved and waitlisted customers as needing a message", () => {
    expect(needsCustomerMessage({ op: "archive_booking", bookingId: 1, reason: "duplicate" })).toBe(false);
    expect(needsCustomerMessage({ op: "move_booking", bookingId: 1, customerId: 1, fromSlot: "10:00", toSlot: "10:20" })).toBe(true);
    expect(needsCustomerMessage({ op: "move_to_event", bookingId: 1, customerId: 1, fromEventId: 1, toEventId: 2, toSlot: "10:00" })).toBe(true);
    expect(needsCustomerMessage({ op: "waitlist_booking", bookingId: 1, customerId: 1, eventId: 1 })).toBe(true);
    apply(propose(first("doubleBookedSlots")));
    const row = db.prepare("SELECT details FROM audit_log ORDER BY id DESC LIMIT 1").get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ issueType: "double_booked_slot", needsMessage: true });
  });

  it("moves an overbooked customer to the other event", () => {
    const issue = first("overbookedEvents");
    const fix = propose(issue);
    apply(fix);
    for (const c of fix.changes) {
      if (c.op !== "move_to_event") throw new Error("expected move_to_event");
      expect(booking(c.bookingId)).toMatchObject({ event_id: c.toEventId, slot: c.toSlot, archived_at: null, waitlisted_at: null });
    }
    expect(runAllChecks(db, TODAY).overbookedEvents).toHaveLength(3);
  });

  it("the same proposal can't be applied twice", () => {
    const fix = propose(first("pastOrCancelledEvents"));
    apply(fix);
    const before = snapshot();
    expect(() => apply(fix)).toThrow(FixError);
    expect(snapshot()).toEqual(before);
  });

  it("fixing everything fixable leaves only the bad contacts; nothing deleted, only duplicates and past/cancelled archived", () => {
    const bookingsBefore = count("SELECT COUNT(*) AS n FROM bookings");
    // Propose again after each fix, so every proposal sees the data as it is now.
    for (let i = 0; i < 100; i++) {
      const fix = Object.values(runAllChecks(db, TODAY)).flat().map((x: Issue) => propose(x)).find((f) => f.fixable);
      if (!fix) break;
      apply(fix);
    }
    const counts = Object.fromEntries(Object.entries(runAllChecks(db, TODAY)).map(([k, v]) => [k, v.length]));
    expect(counts).toEqual({ duplicateBookings: 0, doubleBookedSlots: 0, pastOrCancelledEvents: 0, badContacts: 11, overbookedEvents: 0 });
    expect(count("SELECT COUNT(*) AS n FROM bookings")).toBe(bookingsBefore);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE archive_reason = 'duplicate'")).toBe(12);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE archive_reason IN ('past_event', 'cancelled_event')")).toBe(15);
    expect(count("SELECT COUNT(*) AS n FROM bookings WHERE archived_at IS NOT NULL")).toBe(27);
  });
});

describe("applyFix — rollback: an error in the middle leaves the database exactly as before", () => {
  /** A proposal with custom changes, and its valid code — so only the failure is being tested. */
  const withChanges = (fix: FixProposal, changes: Change[]): FixProposal => ({ ...fix, changes });

  it("when a later change no longer applies (stale proposal)", () => {
    const fix = propose(first("overbookedEvents"));
    const broken = withChanges(fix, [...fix.changes, { op: "waitlist_booking", bookingId: 999_999, customerId: 1, eventId: 1 }]);
    const before = snapshot();
    expect(() => apply(broken)).toThrow(FixError);
    expect(snapshot()).toEqual(before);
  });

  it("when the database itself refuses a change (CHECK constraint)", () => {
    const issue = first("doubleBookedSlots");
    const move = propose(issue).changes[0];
    if (move?.op !== "move_booking") throw new Error("expected move_booking");
    const ok = propose(first("duplicateBookings")).changes;
    // Valid archives first, then a move to a slot that breaks the HH:MM rule.
    const broken = withChanges(propose(issue), [...ok, { ...move, toSlot: "late" }]);
    const before = snapshot();
    expect(() => apply(broken)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("when writing the audit_log fails after the booking was already updated", () => {
    const issue = first("pastOrCancelledEvents");
    const fix = propose(issue);
    // A trigger that makes every audit_log insert fail — simulates e.g. a full disk at the worst moment.
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log unavailable'); END;");
    const before = snapshot();
    expect(() => apply(fix)).toThrow(/audit_log unavailable/);
    expect(snapshot()).toEqual(before);
    expect(booking(issue.bookingId).archived_at).toBeNull();
  });
});
