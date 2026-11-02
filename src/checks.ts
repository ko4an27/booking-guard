import { contactProblems, isValidEmail, isValidPhone } from "./contacts.ts";
import type { ContactProblem } from "./contacts.ts";
import type { Db, EventStatus } from "./db.ts";

// ---------- Issue types: one per problem from CLAUDE.md ----------

export interface DuplicateBookingIssue {
  type: "duplicate_booking";
  eventId: number;
  city: string;
  date: string;
  customerId: number;
  email: string | null;
  bookingIds: number[];
}

export interface DoubleBookedSlotIssue {
  type: "double_booked_slot";
  eventId: number;
  city: string;
  date: string;
  slot: string;
  bookingIds: number[];
  customerIds: number[];
}

export interface PastOrCancelledEventIssue {
  type: "past_or_cancelled_event";
  bookingId: number;
  customerId: number;
  eventId: number;
  city: string;
  date: string;
  status: EventStatus;
  reasons: Array<"past" | "cancelled">;
}

export interface BadContactIssue {
  type: "bad_contact";
  customerId: number;
  email: string | null;
  phone: string | null;
  problems: ContactProblem[];
  bookingCount: number;
}

export interface OverbookedEventIssue {
  type: "overbooked_event";
  eventId: number;
  city: string;
  date: string;
  capacity: number;
  booked: number;
}

export type Issue =
  | DuplicateBookingIssue
  | DoubleBookedSlotIssue
  | PastOrCancelledEventIssue
  | BadContactIssue
  | OverbookedEventIssue;

/** All results, keyed the same way as `errors` in tests/expected.json. */
export interface CheckResults {
  duplicateBookings: DuplicateBookingIssue[];
  doubleBookedSlots: DoubleBookedSlotIssue[];
  pastOrCancelledEvents: PastOrCancelledEventIssue[];
  badContacts: BadContactIssue[];
  overbookedEvents: OverbookedEventIssue[];
}

/** Today's date as YYYY-MM-DD in UTC — the same calendar the seed uses. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const ids = (json: string): number[] => JSON.parse(json) as number[];

// Every check looks at ACTIVE bookings only: a booking archived by a fix is no longer a problem.

// ---------- 1. Duplicate bookings ----------

export function checkDuplicateBookings(db: Db): DuplicateBookingIssue[] {
  const rows = db
    .prepare(
      `SELECT b.event_id, e.city, e.date, b.customer_id, c.email,
              json_group_array(b.id ORDER BY b.id) AS booking_ids
         FROM bookings b
         JOIN events e    ON e.id = b.event_id
         JOIN customers c ON c.id = b.customer_id
        WHERE b.archived_at IS NULL
        GROUP BY b.event_id, b.customer_id
       HAVING COUNT(*) > 1
        ORDER BY b.event_id, b.customer_id`,
    )
    .all() as Array<{ event_id: number; city: string; date: string; customer_id: number; email: string | null; booking_ids: string }>;
  return rows.map((r) => ({
    type: "duplicate_booking",
    eventId: r.event_id,
    city: r.city,
    date: r.date,
    customerId: r.customer_id,
    email: r.email,
    bookingIds: ids(r.booking_ids),
  }));
}

// ---------- 2. Double-booked slots ----------

export function checkDoubleBookedSlots(db: Db): DoubleBookedSlotIssue[] {
  // COUNT(DISTINCT customer_id) > 1: the SAME customer twice in one slot is a duplicate (check 1),
  // so it is not reported here as well.
  const rows = db
    .prepare(
      `SELECT b.event_id, e.city, e.date, b.slot,
              json_group_array(b.id ORDER BY b.id)          AS booking_ids,
              json_group_array(b.customer_id ORDER BY b.id) AS customer_ids
         FROM bookings b
         JOIN events e ON e.id = b.event_id
        WHERE b.archived_at IS NULL
        GROUP BY b.event_id, b.slot
       HAVING COUNT(DISTINCT b.customer_id) > 1
        ORDER BY b.event_id, b.slot`,
    )
    .all() as Array<{ event_id: number; city: string; date: string; slot: string; booking_ids: string; customer_ids: string }>;
  return rows.map((r) => ({
    type: "double_booked_slot",
    eventId: r.event_id,
    city: r.city,
    date: r.date,
    slot: r.slot,
    bookingIds: ids(r.booking_ids),
    customerIds: ids(r.customer_ids),
  }));
}

// ---------- 3. Bookings for past or cancelled events ----------

export function checkPastOrCancelledEvents(db: Db, today: string): PastOrCancelledEventIssue[] {
  // Dates are stored as YYYY-MM-DD text, which sorts the same way as the dates themselves,
  // so a plain text comparison "date < today" is correct.
  const rows = db
    .prepare(
      `SELECT b.id AS booking_id, b.customer_id, e.id AS event_id, e.city, e.date, e.status
         FROM bookings b
         JOIN events e ON e.id = b.event_id
        WHERE b.archived_at IS NULL
          AND (e.date < @today OR e.status = 'cancelled')
        ORDER BY b.id`,
    )
    .all({ today }) as Array<{ booking_id: number; customer_id: number; event_id: number; city: string; date: string; status: EventStatus }>;
  return rows.map((r) => ({
    type: "past_or_cancelled_event",
    bookingId: r.booking_id,
    customerId: r.customer_id,
    eventId: r.event_id,
    city: r.city,
    date: r.date,
    status: r.status,
    reasons: [...(r.date < today ? (["past"] as const) : []), ...(r.status === "cancelled" ? (["cancelled"] as const) : [])],
  }));
}

// ---------- 4. Empty or malformed contact data ----------

export function checkBadContacts(db: Db): BadContactIssue[] {
  // SQLite has no regular expressions, so we register our TypeScript validators as SQL functions.
  // That way SQL and the rest of the code use exactly the same definition of "valid".
  db.function("is_valid_email", { deterministic: true }, (v: unknown) => (isValidEmail(v as string | null) ? 1 : 0));
  db.function("is_valid_phone", { deterministic: true }, (v: unknown) => (isValidPhone(v as string | null) ? 1 : 0));
  // LEFT JOIN keeps customers with zero bookings; COUNT(b.id) then gives 0 for them.
  // The archived_at condition sits in the JOIN (not in WHERE) so it can't drop those customers.
  const rows = db
    .prepare(
      `SELECT c.id, c.email, c.phone, COUNT(b.id) AS booking_count
         FROM customers c
         LEFT JOIN bookings b ON b.customer_id = c.id AND b.archived_at IS NULL
        WHERE NOT is_valid_email(c.email) OR NOT is_valid_phone(c.phone)
        GROUP BY c.id
        ORDER BY c.id`,
    )
    .all() as Array<{ id: number; email: string | null; phone: string | null; booking_count: number }>;
  return rows.map((r) => ({
    type: "bad_contact",
    customerId: r.id,
    email: r.email,
    phone: r.phone,
    problems: contactProblems(r),
    bookingCount: r.booking_count,
  }));
}

// ---------- 5. Overbooked events ----------

export function checkOverbookedEvents(db: Db): OverbookedEventIssue[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.city, e.date, e.capacity, COUNT(b.id) AS booked
         FROM events e
         JOIN bookings b ON b.event_id = e.id AND b.archived_at IS NULL
        GROUP BY e.id
       HAVING COUNT(b.id) > e.capacity
        ORDER BY e.id`,
    )
    .all() as Array<{ id: number; city: string; date: string; capacity: number; booked: number }>;
  return rows.map((r) => ({
    type: "overbooked_event",
    eventId: r.id,
    city: r.city,
    date: r.date,
    capacity: r.capacity,
    booked: r.booked,
  }));
}

// ---------- All checks ----------

export function runAllChecks(db: Db, today: string): CheckResults {
  return {
    duplicateBookings: checkDuplicateBookings(db),
    doubleBookedSlots: checkDoubleBookedSlots(db),
    pastOrCancelledEvents: checkPastOrCancelledEvents(db, today),
    badContacts: checkBadContacts(db),
    overbookedEvents: checkOverbookedEvents(db),
  };
}
