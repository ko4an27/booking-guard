import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkBadContacts,
  checkDoubleBookedSlots,
  checkDuplicateBookings,
  checkOverbookedEvents,
  checkPastOrCancelledEvents,
  runAllChecks,
  todayUtc,
} from "../src/checks.ts";
import type { CheckResults } from "../src/checks.ts";
import { createSchema, openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";
import type { ExpectedErrors } from "../src/seed.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const TODAY = "2026-11-02";
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8")) as ExpectedErrors;

let db: Db;
afterEach(() => db?.close());

function seeded(options: { clean?: boolean } = {}): Db {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: NOW, ...options }));
  return db;
}

describe("todayUtc", () => {
  it("formats the UTC date", () => {
    expect(todayUtc(new Date("2026-11-02T23:30:00-02:00"))).toBe("2026-11-03");
  });
});

describe("checks on the seeded database find exactly the counts in tests/expected.json", () => {
  it("1. duplicate bookings", () => {
    const issues = checkDuplicateBookings(seeded());
    expect(issues).toHaveLength(expected.errors.duplicateBookings.count);
    for (const i of issues) expect(i.bookingIds.length).toBeGreaterThan(1);
  });

  it("2. double-booked slots", () => {
    const issues = checkDoubleBookedSlots(seeded());
    expect(issues).toHaveLength(expected.errors.doubleBookedSlots.count);
    for (const i of issues) expect(new Set(i.customerIds).size).toBeGreaterThan(1);
  });

  it("3. bookings for past or cancelled events", () => {
    const issues = checkPastOrCancelledEvents(seeded(), TODAY);
    const e = expected.errors.pastOrCancelledEvents;
    expect(issues).toHaveLength(e.count);
    expect(issues.filter((i) => i.reasons.includes("past"))).toHaveLength(e.past);
    expect(issues.filter((i) => i.reasons.includes("cancelled"))).toHaveLength(e.cancelled);
  });

  it("4. empty or malformed contact data", () => {
    const issues = checkBadContacts(seeded());
    expect(issues).toHaveLength(expected.errors.badContacts.count);
    for (const i of issues) expect(i.problems.length).toBeGreaterThan(0);
  });

  it("5. overbooked events", () => {
    const issues = checkOverbookedEvents(seeded());
    expect(issues).toHaveLength(expected.errors.overbookedEvents.count);
    for (const i of issues) expect(i.booked).toBeGreaterThan(i.capacity);
  });

  it("runAllChecks returns the same keys and counts as expected.json", () => {
    const results = runAllChecks(seeded(), TODAY);
    const counts = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.length]));
    const want = Object.fromEntries(Object.entries(expected.errors).map(([k, v]) => [k, v.count]));
    expect(counts).toEqual(want);
  });
});

describe("no false positives", () => {
  const expectNoIssues = (results: CheckResults) => {
    for (const issues of Object.values(results)) expect(issues).toEqual([]);
  };

  it("a clean seeded database (~400 bookings, no deliberate errors) returns zero issues", () => {
    const d = seeded({ clean: true });
    expect((d.prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number }).n).toBeGreaterThan(300);
    expectNoIssues(runAllChecks(d, TODAY));
  });

  it("near-misses that look like problems but are not return zero issues", () => {
    db = openDb(":memory:");
    createSchema(db);
    const slots = JSON.stringify(["10:00", "10:20", "10:40"]);
    db.exec(`
      INSERT INTO events (id, city, date, time_slots, capacity, status) VALUES
        (1, 'Oulu',  '${TODAY}',    '${slots}', 2, 'scheduled'),  -- today is not "past"; exactly at capacity
        (2, 'Turku', '2026-12-01', '${slots}', 3, 'scheduled'),
        (3, 'Espoo', '2025-01-01', '${slots}', 3, 'cancelled');   -- past AND cancelled, but has no bookings
      INSERT INTO customers (id, name, email, phone) VALUES
        (1, 'Test One', 'one@example.com', '+358 40 123 4567'),
        (2, 'Test Two', 'two@example.com', '+358401234567');      -- valid without spaces
      INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES
        (1, 1, '10:00', '2026-10-01T10:00:00Z'),
        (1, 2, '10:20', '2026-10-01T10:00:00Z'),
        (2, 1, '10:00', '2026-10-01T10:00:00Z'),  -- same customer, DIFFERENT event: not a duplicate
        (2, 2, '10:20', '2026-10-01T10:00:00Z');  -- same slot as event 1, DIFFERENT event: not double-booked
    `);
    expectNoIssues(runAllChecks(db, TODAY));
  });

  it("the same customer twice in the same slot is reported once, as a duplicate only", () => {
    db = openDb(":memory:");
    createSchema(db);
    db.exec(`
      INSERT INTO events (id, city, date, time_slots, capacity) VALUES (1, 'Oulu', '2026-12-01', '["10:00"]', 5);
      INSERT INTO customers (id, name, email, phone) VALUES (1, 'Test One', 'one@example.com', '+358 40 123 4567');
      INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, 1, '10:00', 'x'), (1, 1, '10:00', 'x');
    `);
    expect(checkDuplicateBookings(db)).toHaveLength(1);
    expect(checkDoubleBookedSlots(db)).toEqual([]);
  });

  it("an empty database returns zero issues", () => {
    db = openDb(":memory:");
    createSchema(db);
    expectNoIssues(runAllChecks(db, TODAY));
  });
});

describe("issue details", () => {
  it("duplicate issue carries ids and booking list in order", () => {
    db = openDb(":memory:");
    createSchema(db);
    db.exec(`
      INSERT INTO events (id, city, date, time_slots, capacity) VALUES (7, 'Kuopio', '2026-12-01', '["10:00","10:20"]', 5);
      INSERT INTO customers (id, name, email, phone) VALUES (3, 'Test', 't@example.com', '+358 40 123 4567');
      INSERT INTO bookings (id, event_id, customer_id, slot, created_at) VALUES (20, 7, 3, '10:20', 'x'), (10, 7, 3, '10:00', 'x');
    `);
    expect(checkDuplicateBookings(db)).toEqual([
      { type: "duplicate_booking", eventId: 7, city: "Kuopio", date: "2026-12-01", customerId: 3, email: "t@example.com", bookingIds: [10, 20] },
    ]);
  });

  it("bad-contact issue lists the problems and counts bookings (0 for a customer with none)", () => {
    db = openDb(":memory:");
    createSchema(db);
    db.exec("INSERT INTO customers (id, name, email, phone) VALUES (1, 'Test', NULL, '123')");
    expect(checkBadContacts(db)).toEqual([
      { type: "bad_contact", customerId: 1, email: null, phone: "123", problems: ["email_missing", "phone_malformed"], bookingCount: 0 },
    ]);
  });
});

describe("archived bookings", () => {
  it("are ignored by every check", () => {
    const d = seeded();
    d.exec("UPDATE bookings SET archived_at = '2026-11-03T00:00:00Z', archive_reason = 'duplicate'");
    const results = runAllChecks(d, TODAY);
    expect(results.duplicateBookings).toEqual([]);
    expect(results.doubleBookedSlots).toEqual([]);
    expect(results.pastOrCancelledEvents).toEqual([]);
    expect(results.overbookedEvents).toEqual([]);
    // Bad contacts are about customers, so they are still found — now with 0 active bookings.
    expect(results.badContacts).toHaveLength(expected.errors.badContacts.count);
    for (const i of results.badContacts) expect(i.bookingCount).toBe(0);
  });
});
