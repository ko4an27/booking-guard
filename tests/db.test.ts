import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSchema, dropSchema, openDb } from "../src/db.ts";
import type { Db } from "../src/db.ts";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  createSchema(db);
});
afterEach(() => db.close());

const tables = () =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

const addEvent = (overrides: Record<string, unknown> = {}) =>
  db
    .prepare("INSERT INTO events (city, date, time_slots, capacity, status) VALUES (@city, @date, @time_slots, @capacity, @status)")
    .run({ city: "Oulu", date: "2026-12-01", time_slots: '["10:00","10:20"]', capacity: 10, status: "scheduled", ...overrides });

describe("schema", () => {
  it("creates the four tables", () => {
    expect(tables()).toEqual(["audit_log", "bookings", "customers", "events"]);
  });

  it("can be created twice without error", () => {
    expect(() => createSchema(db)).not.toThrow();
  });

  it("dropSchema removes all tables", () => {
    dropSchema(db);
    expect(tables()).toEqual([]);
  });

  it("has foreign keys switched on", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() =>
      db.prepare("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (999, 999, '10:00', 'x')").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("accepts a valid event", () => {
    expect(addEvent().changes).toBe(1);
  });

  it.each([
    ["unknown status", { status: "done" }],
    ["invalid date", { date: "1.12.2026" }],
    ["time_slots that are not JSON", { time_slots: "10:00,10:20" }],
    ["time_slots that are not an array", { time_slots: '{"a":1}' }],
    ["zero capacity", { capacity: 0 }],
    ["text capacity (STRICT table)", { capacity: "ten" }],
  ])("rejects an event with %s", (_label, overrides) => {
    expect(() => addEvent(overrides)).toThrow();
  });

  it("rejects a booking slot that is not HH:MM", () => {
    addEvent();
    db.prepare("INSERT INTO customers (name) VALUES ('Test Person')").run();
    expect(() =>
      db.prepare("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, 1, '10am', 'x')").run(),
    ).toThrow();
  });

  it("allows customers without email or phone (the agent must be able to find them)", () => {
    expect(db.prepare("INSERT INTO customers (name, email, phone) VALUES ('No Contact', NULL, NULL)").run().changes).toBe(1);
  });

  it("allows duplicate bookings and double-booked slots (the agent must be able to find them)", () => {
    addEvent();
    db.prepare("INSERT INTO customers (name) VALUES ('A'), ('B')").run();
    const insert = db.prepare("INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, ?, '10:00', 'x')");
    insert.run(1);
    insert.run(1);
    insert.run(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bookings").get()).toEqual({ n: 3 });
  });

  it("fills audit_log.ts automatically and requires JSON details", () => {
    db.prepare("INSERT INTO audit_log (action, details) VALUES ('test', '{}')").run();
    const row = db.prepare("SELECT ts FROM audit_log").get() as { ts: string };
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(() => db.prepare("INSERT INTO audit_log (action, details) VALUES ('test', 'not json')").run()).toThrow();
  });
});

describe("booking archive columns", () => {
  beforeEach(() => {
    addEvent();
    db.prepare("INSERT INTO customers (name) VALUES ('Test Person')").run();
  });
  const insert = (archivedAt: string | null, reason: string | null) =>
    db
      .prepare("INSERT INTO bookings (event_id, customer_id, slot, created_at, archived_at, archive_reason) VALUES (1, 1, '10:00', 'x', ?, ?)")
      .run(archivedAt, reason);

  it("new bookings are active (not archived)", () => {
    insert(null, null);
    expect(db.prepare("SELECT archived_at, archive_reason FROM bookings").get()).toEqual({ archived_at: null, archive_reason: null });
  });
  it("accepts an archived booking with a known reason", () => {
    expect(insert("2026-11-03T00:00:00Z", "past_event").changes).toBe(1);
  });
  it.each([
    ["a reason but no time", null, "duplicate"],
    ["a time but no reason", "2026-11-03T00:00:00Z", null],
    ["an unknown reason", "2026-11-03T00:00:00Z", "deleted"],
  ])("rejects %s", (_label, at, reason) => {
    expect(() => insert(at, reason)).toThrow();
  });
});
