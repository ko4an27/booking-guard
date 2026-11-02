import Database from "better-sqlite3";

export type Db = Database.Database;

export const DEFAULT_DB_PATH = "data/booking-guard.db";

export type EventStatus = "scheduled" | "cancelled";

export interface EventRow {
  id: number;
  city: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  /** JSON array of start times, e.g. ["10:00","10:20"]. */
  time_slots: string;
  capacity: number;
  status: EventStatus;
}

export interface CustomerRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface BookingRow {
  id: number;
  event_id: number;
  customer_id: number;
  /** Start time, HH:MM — one of the event's time_slots. */
  slot: string;
  /** ISO 8601 timestamp. */
  created_at: string;
}

export interface AuditLogRow {
  id: number;
  ts: string;
  action: string;
  /** JSON object describing the change. */
  details: string;
}

// The schema deliberately has NO unique constraints on (customer_id, event_id) or (event_id, slot)
// and allows empty contact fields: those are exactly the problems the agent must find, so the
// database has to be able to hold them. CHECK constraints still block data that is plain garbage.
// STRICT tables make SQLite reject values of the wrong type instead of silently converting them.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  city       TEXT    NOT NULL,
  date       TEXT    NOT NULL CHECK (date IS date(date)),
  time_slots TEXT    NOT NULL CHECK (json_valid(time_slots) AND json_type(time_slots) = 'array'),
  capacity   INTEGER NOT NULL CHECK (capacity > 0),
  status     TEXT    NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled'))
) STRICT;

CREATE TABLE IF NOT EXISTS customers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT,
  phone TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  slot        TEXT    NOT NULL CHECK (slot GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_at  TEXT    NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_bookings_event    ON bookings(event_id);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  action  TEXT NOT NULL,
  details TEXT NOT NULL CHECK (json_valid(details))
) STRICT;
`;

/** Opens (or creates) a database file. Foreign keys are off by default in SQLite, so we turn them on. */
export function openDb(path: string = DEFAULT_DB_PATH): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

/** Creates all tables and indexes. Safe to call on a database that already has them. */
export function createSchema(db: Db): void {
  db.exec(SCHEMA_SQL);
}

/** Drops all tables. Children (bookings) go before parents so foreign keys never block the drop. */
export function dropSchema(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS bookings;
    DROP TABLE IF EXISTS customers;
    DROP TABLE IF EXISTS events;
    DROP TABLE IF EXISTS audit_log;
  `);
}
