import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import type { CustomerRow, Db } from "../src/db.ts";
import { generateSeedData, generateTimeSlots, seedDatabase } from "../src/seed.ts";
import type { ExpectedErrors } from "../src/seed.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const TODAY = "2026-11-02";
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8")) as ExpectedErrors;

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: NOW }));
});
afterEach(() => db.close());

const count = (sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { n: number }).n;

// The same rules expected.json documents for "malformed" contact data.
const validEmail = (e: string | null) => e !== null && new RegExp(expected.errors.badContacts.emailRule).test(e);
const validPhone = (p: string | null) => p !== null && /^\+358\d{7,10}$/.test(p.replace(/ /g, ""));

describe("generateTimeSlots", () => {
  it("makes 24 slots of 20 minutes from 10:00", () => {
    const slots = generateTimeSlots();
    expect(slots).toHaveLength(24);
    expect(slots[0]).toBe("10:00");
    expect(slots[1]).toBe("10:20");
    expect(slots[23]).toBe("17:40");
  });
});

describe("generateSeedData", () => {
  it("is deterministic", () => {
    expect(generateSeedData({ now: NOW })).toEqual(generateSeedData({ now: NOW }));
  });

  it("matches the committed tests/expected.json (re-run `npm run seed` if the generator changed)", () => {
    expect(generateSeedData({ now: NOW }).expected).toEqual(expected);
    // Counts don't depend on the date of seeding, only on the RNG seed.
    expect(generateSeedData({ now: new Date("2030-06-15T08:00:00Z") }).expected).toEqual(expected);
  });

  it("only uses fake @example.com addresses", () => {
    const emails = generateSeedData({ now: NOW }).customers.map((c) => c.email).filter(validEmail);
    expect(emails.length).toBeGreaterThan(300);
    for (const e of emails) expect(e).toMatch(/@example\.com$/);
  });
});

describe("seedDatabase", () => {
  it("creates ~500 bookings across 8 cities", () => {
    expect(count("SELECT COUNT(DISTINCT city) AS n FROM events")).toBe(8);
    expect(count("SELECT COUNT(*) AS n FROM events")).toBe(expected.totals.events);
    expect(count("SELECT COUNT(*) AS n FROM customers")).toBe(expected.totals.customers);
    const bookings = count("SELECT COUNT(*) AS n FROM bookings");
    expect(bookings).toBe(expected.totals.bookings);
    expect(bookings).toBeGreaterThanOrEqual(450);
    expect(bookings).toBeLessThanOrEqual(550);
  });

  it("books every booking into one of its event's time slots", () => {
    expect(
      count(`SELECT COUNT(*) AS n FROM bookings b JOIN events e ON e.id = b.event_id
             WHERE b.slot NOT IN (SELECT value FROM json_each(e.time_slots))`),
    ).toBe(0);
  });

  it("writes one 'seed' entry to audit_log", () => {
    expect(count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'seed'")).toBe(1);
  });

  it("replaces old data instead of adding to it", () => {
    seedDatabase(db, generateSeedData({ now: NOW }));
    expect(count("SELECT COUNT(*) AS n FROM bookings")).toBe(expected.totals.bookings);
  });

  it("rolls back completely if any insert fails", () => {
    const broken = generateSeedData({ now: NOW });
    broken.events = broken.events.map((e, i) => (i === 5 ? { ...e, status: "done" as "cancelled" } : e));
    broken.customers = [];
    expect(() => seedDatabase(db, broken)).toThrow();
    expect(count("SELECT COUNT(*) AS n FROM bookings")).toBe(expected.totals.bookings);
    expect(count("SELECT COUNT(*) AS n FROM customers")).toBe(expected.totals.customers);
  });
});

describe("seeded errors match tests/expected.json", () => {
  it("1. duplicate bookings", () => {
    expect(
      count("SELECT COUNT(*) AS n FROM (SELECT 1 FROM bookings GROUP BY customer_id, event_id HAVING COUNT(*) > 1)"),
    ).toBe(expected.errors.duplicateBookings.count);
  });

  it("2. double-booked slots", () => {
    expect(
      count("SELECT COUNT(*) AS n FROM (SELECT 1 FROM bookings GROUP BY event_id, slot HAVING COUNT(*) > 1)"),
    ).toBe(expected.errors.doubleBookedSlots.count);
  });

  it("3. bookings for past or cancelled events", () => {
    const e = expected.errors.pastOrCancelledEvents;
    const base = "SELECT COUNT(*) AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE ";
    expect(count(`${base} e.date < ?`, TODAY)).toBe(e.past);
    expect(count(`${base} e.status = 'cancelled'`)).toBe(e.cancelled);
    expect(count(`${base} e.date < ? OR e.status = 'cancelled'`, TODAY)).toBe(e.count);
  });

  it("4. customers with empty or malformed contact data", () => {
    const customers = db.prepare("SELECT * FROM customers").all() as CustomerRow[];
    expect(customers.filter((c) => !validEmail(c.email) || !validPhone(c.phone))).toHaveLength(
      expected.errors.badContacts.count,
    );
  });

  it("5. overbooked events", () => {
    expect(
      count("SELECT COUNT(*) AS n FROM events e WHERE (SELECT COUNT(*) FROM bookings b WHERE b.event_id = e.id) > e.capacity"),
    ).toBe(expected.errors.overbookedEvents.count);
  });

  it("errors don't overlap: duplicates, double-bookings and bad contacts are only on clean events", () => {
    const cleanEvent = `e.status = 'scheduled' AND e.date >= '${TODAY}'
      AND (SELECT COUNT(*) FROM bookings x WHERE x.event_id = e.id) <= e.capacity`;
    expect(
      count(`SELECT COUNT(*) AS n FROM (SELECT b.event_id FROM bookings b JOIN events e ON e.id = b.event_id
             WHERE NOT (${cleanEvent}) GROUP BY b.event_id, b.customer_id HAVING COUNT(*) > 1)`),
    ).toBe(0);
    expect(
      count(`SELECT COUNT(*) AS n FROM (SELECT b.event_id FROM bookings b JOIN events e ON e.id = b.event_id
             WHERE NOT (${cleanEvent}) GROUP BY b.event_id, b.slot HAVING COUNT(*) > 1)`),
    ).toBe(0);
    const customers = db.prepare("SELECT * FROM customers").all() as CustomerRow[];
    for (const c of customers.filter((x) => !validEmail(x.email) || !validPhone(x.phone))) {
      expect(count(`SELECT COUNT(*) AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.customer_id = ? AND ${cleanEvent}`, c.id)).toBe(1);
      expect(count("SELECT COUNT(*) AS n FROM bookings WHERE customer_id = ?", c.id)).toBe(1);
    }
  });
});
