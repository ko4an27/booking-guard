import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAllChecks } from "../src/checks.ts";
import type { CheckResults, Issue } from "../src/checks.ts";
import { createSchema, openDb } from "../src/db.ts";
import type { BookingRow, Db } from "../src/db.ts";
import { applyFix, confirmationCode, FixError, proposeFix } from "../src/fixes.ts";
import type { Change, FixProposal } from "../src/fixes.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";

const TODAY = "2026-11-02";
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

const first = <K extends keyof CheckResults>(key: K): CheckResults[K][number] => {
  const issue = runAllChecks(db, TODAY)[key][0];
  if (!issue) throw new Error(`no ${key} issue in seed`);
  return issue;
};

const booking = (id: number) => db.prepare("SELECT * FROM bookings WHERE id = ?").get(id) as BookingRow;
const auditCount = () => (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
const apply = (fix: FixProposal) => applyFix(db, fix, { dryRun: false, confirmationCode: fix.confirmationCode });

describe("confirmationCode", () => {
  it("is 6 characters and the same for the same changes", () => {
    const changes: Change[] = [{ op: "archive_booking", bookingId: 1, reason: "duplicate" }];
    expect(confirmationCode(changes)).toMatch(/^[0-9A-F]{6}$/);
    expect(confirmationCode(changes)).toBe(confirmationCode([...changes]));
  });

  it("changes when the changes change", () => {
    expect(confirmationCode([{ op: "archive_booking", bookingId: 1, reason: "duplicate" }])).not.toBe(
      confirmationCode([{ op: "archive_booking", bookingId: 2, reason: "duplicate" }]),
    );
  });
});

describe("proposeFix", () => {
  it("modifies nothing, for every issue in the seeded database", () => {
    const before = snapshot();
    const issues: Issue[] = Object.values(runAllChecks(db, TODAY)).flat();
    expect(issues).toHaveLength(51);
    for (const issue of issues) proposeFix(db, issue);
    expect(snapshot()).toEqual(before);
  });

  it("duplicate: keeps the booking made first and archives the others", () => {
    const issue = first("duplicateBookings");
    const fix = proposeFix(db, issue);
    const [keep, ...rest] = [...issue.bookingIds].sort((a, b) => booking(a).created_at.localeCompare(booking(b).created_at));
    expect(fix.fixable).toBe(true);
    expect(fix.changes).toEqual(rest.map((id) => ({ op: "archive_booking", bookingId: id, reason: "duplicate" })));
    expect(fix.changes.some((c) => c.bookingId === keep)).toBe(false);
  });

  it("double-booked slot: moves the later booking to a free slot of the same event", () => {
    const issue = first("doubleBookedSlots");
    const fix = proposeFix(db, issue);
    expect(fix.changes).toHaveLength(1);
    const change = fix.changes[0];
    expect(change?.op).toBe("move_booking");
    if (change?.op !== "move_booking") return;
    expect(change.fromSlot).toBe(issue.slot);
    const used = (db.prepare("SELECT slot FROM bookings WHERE event_id = ?").all(issue.eventId) as { slot: string }[]).map((r) => r.slot);
    expect(used).not.toContain(change.toSlot);
  });

  it("past or cancelled event: archives the booking (never deletes)", () => {
    const issue = first("pastOrCancelledEvents");
    expect(proposeFix(db, issue).changes).toEqual([
      { op: "archive_booking", bookingId: issue.bookingId, reason: issue.reasons.includes("cancelled") ? "cancelled_event" : "past_event" },
    ]);
  });

  it("bad contact data: not fixable automatically", () => {
    const fix = proposeFix(db, first("badContacts"));
    expect(fix.fixable).toBe(false);
    expect(fix.changes).toEqual([]);
    expect(fix.summary).not.toMatch(/@|\+358/); // no contact data in the text (rule 4)
  });

  it("overbooked event: archives exactly the most recent bookings over capacity", () => {
    const issue = first("overbookedEvents");
    const fix = proposeFix(db, issue);
    expect(fix.changes).toHaveLength(issue.booked - issue.capacity);
    const newest = (db.prepare("SELECT id FROM bookings WHERE event_id = ? ORDER BY created_at DESC LIMIT ?").all(
      issue.eventId,
      issue.booked - issue.capacity,
    ) as { id: number }[]).map((r) => r.id);
    expect(fix.changes.map((c) => c.bookingId).sort()).toEqual(newest.sort());
  });

  it("double-booked slot with no free slot left: not fixable", () => {
    const d = openDb(":memory:");
    createSchema(d);
    d.exec(`
      INSERT INTO events (id, city, date, time_slots, capacity) VALUES (1, 'Oulu', '2026-12-01', '["10:00"]', 5);
      INSERT INTO customers (id, name) VALUES (1, 'A'), (2, 'B');
      INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, 1, '10:00', 'a'), (1, 2, '10:00', 'b');
    `);
    const issue = runAllChecks(d, TODAY).doubleBookedSlots[0] as Issue;
    expect(proposeFix(d, issue).fixable).toBe(false);
    d.close();
  });
});

describe("applyFix — safe by default", () => {
  it("is a dry run by default and changes nothing, even with the right code", () => {
    const fix = proposeFix(db, first("duplicateBookings"));
    const before = snapshot();
    expect(applyFix(db, fix).status).toBe("dry_run");
    expect(applyFix(db, fix, { confirmationCode: fix.confirmationCode }).status).toBe("dry_run");
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["no code", undefined],
    ["a wrong code", "000000"],
    ["the right code in lower case", "lower"],
  ])("with %s it changes nothing", (_label, code) => {
    const fix = proposeFix(db, first("duplicateBookings"));
    const given = code === "lower" ? fix.confirmationCode.toLowerCase() : code;
    const before = snapshot();
    expect(applyFix(db, fix, { dryRun: false, ...(given === undefined ? {} : { confirmationCode: given }) })).toEqual({
      status: "rejected",
      reason: "wrong_confirmation_code",
    });
    expect(snapshot()).toEqual(before);
  });

  it("refuses a proposal whose changes were edited after the code was issued", () => {
    const fix = proposeFix(db, first("duplicateBookings"));
    const tampered: FixProposal = { ...fix, changes: [{ op: "archive_booking", bookingId: 1, reason: "duplicate" }] };
    const before = snapshot();
    expect(applyFix(db, tampered, { dryRun: false, confirmationCode: fix.confirmationCode }).status).toBe("rejected");
    expect(snapshot()).toEqual(before);
  });

  it("refuses a not-fixable proposal", () => {
    const fix = proposeFix(db, first("badContacts"));
    expect(applyFix(db, fix, { dryRun: false, confirmationCode: fix.confirmationCode })).toEqual({ status: "rejected", reason: "not_fixable" });
  });
});

describe("applyFix — applying", () => {
  it("archives (never deletes) and writes one audit_log row per change", () => {
    const fix = proposeFix(db, first("duplicateBookings"));
    const bookingsBefore = (db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n;
    const auditBefore = auditCount();
    const result = apply(fix);
    expect(result.status).toBe("applied");
    expect((db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n).toBe(bookingsBefore);
    for (const c of fix.changes) {
      expect(booking(c.bookingId).archive_reason).toBe("duplicate");
      expect(booking(c.bookingId).archived_at).not.toBeNull();
    }
    expect(auditCount()).toBe(auditBefore + fix.changes.length);
    const row = db.prepare("SELECT action, details FROM audit_log ORDER BY id DESC LIMIT 1").get() as { action: string; details: string };
    expect(row.action).toBe("archive_booking");
    expect(JSON.parse(row.details)).toMatchObject({ issueType: "duplicate_booking", confirmationCode: fix.confirmationCode });
  });

  it("moves a double-booked customer and the slot is no longer shared", () => {
    const issue = first("doubleBookedSlots");
    const fix = proposeFix(db, issue);
    apply(fix);
    const change = fix.changes[0];
    if (change?.op !== "move_booking") throw new Error("expected a move");
    expect(booking(change.bookingId).slot).toBe(change.toSlot);
    expect(runAllChecks(db, TODAY).doubleBookedSlots).toHaveLength(8);
  });

  it("the same proposal can't be applied twice", () => {
    const fix = proposeFix(db, first("pastOrCancelledEvents"));
    apply(fix);
    const before = snapshot();
    expect(() => apply(fix)).toThrow(FixError);
    expect(snapshot()).toEqual(before);
  });

  it("fixing everything fixable leaves only the bad contacts, and nothing is deleted", () => {
    const bookingsBefore = (db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n;
    // Propose again after each fix, so every proposal sees the data as it is now.
    for (let i = 0; i < 100; i++) {
      const fix = Object.values(runAllChecks(db, TODAY)).flat().map((x: Issue) => proposeFix(db, x)).find((f) => f.fixable);
      if (!fix) break;
      apply(fix);
    }
    const counts = Object.fromEntries(Object.entries(runAllChecks(db, TODAY)).map(([k, v]) => [k, v.length]));
    expect(counts).toEqual({ duplicateBookings: 0, doubleBookedSlots: 0, pastOrCancelledEvents: 0, badContacts: 11, overbookedEvents: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n).toBe(bookingsBefore);
  });
});

describe("applyFix — rollback: an error in the middle leaves the database exactly as before", () => {
  it("when a later change no longer applies (stale proposal)", () => {
    const fix = proposeFix(db, first("overbookedEvents"));
    expect(fix.changes.length).toBeGreaterThan(0);
    // First change is fine, second points at a booking that doesn't exist.
    const changes: Change[] = [...fix.changes, { op: "archive_booking", bookingId: 999_999, reason: "overbooked" }];
    const broken: FixProposal = { ...fix, changes, confirmationCode: confirmationCode(changes) };
    const before = snapshot();
    expect(() => applyFix(db, broken, { dryRun: false, confirmationCode: broken.confirmationCode })).toThrow(FixError);
    expect(snapshot()).toEqual(before);
  });

  it("when the database itself refuses a change (CHECK constraint)", () => {
    const issue = first("doubleBookedSlots");
    const fix = proposeFix(db, issue);
    const ok = proposeFix(db, first("duplicateBookings")).changes;
    // Valid archives first, then a move to a slot that breaks the HH:MM rule.
    const changes: Change[] = [...ok, { op: "move_booking", bookingId: fix.changes[0]?.bookingId ?? 0, fromSlot: issue.slot, toSlot: "late" }];
    const broken: FixProposal = { ...fix, changes, confirmationCode: confirmationCode(changes) };
    const before = snapshot();
    expect(() => applyFix(db, broken, { dryRun: false, confirmationCode: broken.confirmationCode })).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("when writing the audit_log fails after the booking was already updated", () => {
    const fix = proposeFix(db, first("pastOrCancelledEvents"));
    // A trigger that makes every audit_log insert fail — simulates e.g. a full disk at the worst moment.
    db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log unavailable'); END;");
    const before = snapshot();
    expect(() => apply(fix)).toThrow(/audit_log unavailable/);
    expect(snapshot()).toEqual(before);
    expect(booking(fix.issue.type === "past_or_cancelled_event" ? fix.issue.bookingId : 0).archived_at).toBeNull();
  });
});
