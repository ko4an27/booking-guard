import { createSchema, dropSchema } from "./db.ts";
import type { BookingRow, CustomerRow, Db, EventRow } from "./db.ts";
import { createRng } from "./random.ts";
import type { Rng } from "./random.ts";

export const DEFAULT_RNG_SEED = 20261102;

export const CITIES = [
  "Helsinki",
  "Espoo",
  "Tampere",
  "Vantaa",
  "Oulu",
  "Turku",
  "Jyväskylä",
  "Kuopio",
] as const;

const EVENTS_PER_CITY = 5;
const GOOD_CUSTOMERS = 320;
/** Every event offers 24 slots of 20 minutes (10:00–17:40) but has capacity for only 18–20 bookings. */
const SLOT_COUNT = 24;
const SLOT_MINUTES = 20;

/**
 * How many errors of each type the seed inserts on purpose.
 * The numbers are all different so a check that reports another check's count is caught by tests.
 */
export const ERROR_PLAN = {
  duplicateBookings: 12,
  doubleBookedSlots: 9,
  /** Bookings per past event (2 past events). */
  pastEventBookings: [3, 4],
  /** Bookings per cancelled event (2 cancelled events with bookings). */
  cancelledEventBookings: [5, 3],
  /** Cancelled events without bookings: realistic, and NOT an error. */
  emptyCancelledEvents: 1,
  overbookedEvents: 4,
} as const;

const FIRST_NAMES = [
  "Matti", "Liisa", "Juha", "Anna", "Mikko", "Maria", "Timo", "Laura", "Jari", "Sanna",
  "Antti", "Heidi", "Pekka", "Johanna", "Ville", "Elina", "Kari", "Tiina", "Janne", "Satu",
];
const LAST_NAMES = [
  "Korhonen", "Virtanen", "Mäkinen", "Nieminen", "Mäkelä", "Hämäläinen", "Laine", "Heikkinen",
  "Koskinen", "Järvinen", "Lehtonen", "Lehtinen", "Saarinen", "Salminen", "Heinonen", "Niemi",
];
const MOBILE_PREFIXES = ["40", "41", "44", "45", "50"];

/** Ways a customer's contact data can be broken. Each one turns a valid customer into a bad one. */
const BAD_CONTACTS: ReadonlyArray<(c: CustomerRow) => Partial<CustomerRow>> = [
  () => ({ email: null }),
  () => ({ email: "" }),
  (c) => ({ email: (c.email ?? "").replace("@", ".") }), // no @ at all
  (c) => ({ email: `${(c.email ?? "").split("@")[0]}@` }), // missing domain
  (c) => ({ email: (c.email ?? "").replace(".", " ") }), // contains a space
  (c) => ({ email: (c.email ?? "").replace("@", "@@") }), // double @
  () => ({ phone: null }),
  () => ({ phone: "" }),
  () => ({ phone: "12345" }), // too short, no country code
  (c) => ({ phone: `${(c.phone ?? "").slice(0, -1)}X` }), // contains a letter
  () => ({ email: null, phone: null }),
];

export interface ExpectedErrors {
  rngSeed: number;
  totals: { cities: number; events: number; customers: number; bookings: number };
  errors: {
    duplicateBookings: { count: number; counts: string };
    doubleBookedSlots: { count: number; counts: string };
    pastOrCancelledEvents: { count: number; past: number; cancelled: number; counts: string };
    badContacts: { count: number; counts: string; emailRule: string; phoneRule: string };
    overbookedEvents: { count: number; counts: string };
  };
}

export interface SeedData {
  events: EventRow[];
  customers: CustomerRow[];
  bookings: BookingRow[];
  expected: ExpectedErrors;
}

type EventRole = "clean" | "past" | "cancelled" | "cancelledEmpty" | "overbooked";

/** Working state for one event while bookings are being generated. */
interface EventState {
  event: EventRow;
  role: EventRole;
  slots: string[];
  slotUse: Map<string, number>;
  customerIds: Set<number>;
  /** Bookings from the initial fill, not yet used as the base of an injected error. */
  untouched: BookingDraft[];
  count: number;
}

type BookingDraft = Omit<BookingRow, "id" | "archived_at" | "archive_reason">;

export function generateTimeSlots(start = "10:00", count = SLOT_COUNT, stepMinutes = SLOT_MINUTES): string[] {
  const [h, m] = start.split(":").map(Number);
  const startMinutes = (h ?? 0) * 60 + (m ?? 0);
  return Array.from({ length: count }, (_, i) => {
    const total = startMinutes + i * stepMinutes;
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Lowercase ASCII version of a Finnish name for use in an e-mail address. */
function slug(s: string): string {
  return s.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/å/g, "a");
}

function makeCustomer(rng: Rng, n: number): CustomerRow {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const digits = (len: number) => Array.from({ length: len }, () => rng.int(0, 9)).join("");
  return {
    id: 0, // assigned after shuffling
    name: `${first} ${last}`,
    // example.com is reserved for documentation, so these addresses can never belong to anyone.
    email: `${slug(first)}.${slug(last)}${n}@example.com`,
    phone: `+358 ${rng.pick(MOBILE_PREFIXES)} ${digits(3)} ${digits(4)}`,
  };
}

/**
 * Builds the whole fake dataset in memory. Pure: the same `now` and `rngSeed` give the same result.
 * Dates are relative to `now`, so "past" and "future" events stay correct whenever you re-seed.
 */
export function generateSeedData(options: { now: Date; rngSeed?: number; clean?: boolean }): SeedData {
  const rngSeed = options.rngSeed ?? DEFAULT_RNG_SEED;
  // clean: true builds the same kind of data with NO deliberate errors (used to test for false positives).
  const clean = options.clean ?? false;
  const n = (planned: number): number => (clean ? 0 : planned);
  const rng = createRng(rngSeed);
  const now = options.now;
  const today = startOfUtcDay(now);

  // --- Customers: good ones plus one bad one per BAD_CONTACTS entry, mixed so bad ids aren't all at the end.
  const good = Array.from({ length: GOOD_CUSTOMERS }, (_, i) => makeCustomer(rng, i + 1));
  const bad = (clean ? [] : BAD_CONTACTS).map((breakIt, i) => {
    const c = makeCustomer(rng, GOOD_CUSTOMERS + i + 1);
    return { ...c, ...breakIt(c) };
  });
  const customers = rng.shuffle([...good, ...bad]);
  customers.forEach((c, i) => (c.id = i + 1));
  const goodIds = good.map((c) => c.id);

  // --- Events: give each of the 40 events a role, then create them city by city.
  const plannedRoles: EventRole[] = rng.shuffle([
    ...ERROR_PLAN.pastEventBookings.map((): EventRole => "past"),
    ...ERROR_PLAN.cancelledEventBookings.map((): EventRole => "cancelled"),
    ...Array.from({ length: ERROR_PLAN.emptyCancelledEvents }, (): EventRole => "cancelledEmpty"),
    ...Array.from({ length: ERROR_PLAN.overbookedEvents }, (): EventRole => "overbooked"),
  ].concat(
    Array.from(
      {
        length:
          CITIES.length * EVENTS_PER_CITY -
          ERROR_PLAN.pastEventBookings.length -
          ERROR_PLAN.cancelledEventBookings.length -
          ERROR_PLAN.emptyCancelledEvents -
          ERROR_PLAN.overbookedEvents,
      },
      (): EventRole => "clean",
    ),
  ));
  const roles = clean ? plannedRoles.map((): EventRole => "clean") : plannedRoles;

  const slots = generateTimeSlots();
  const states: EventState[] = [];
  CITIES.forEach((city, cityIndex) => {
    for (let k = 0; k < EVENTS_PER_CITY; k++) {
      const role = roles[cityIndex * EVENTS_PER_CITY + k] as EventRole;
      // Past events: 5–60 days ago. Everything else: 7–120 days ahead. The gap keeps time zones harmless.
      const offset = role === "past" ? -rng.int(5, 60) : rng.int(7, 120);
      const event: EventRow = {
        id: states.length + 1,
        city,
        date: toIsoDate(new Date(today.getTime() + offset * DAY_MS)),
        time_slots: JSON.stringify(slots),
        capacity: rng.int(18, 20),
        status: role === "cancelled" || role === "cancelledEmpty" ? "cancelled" : "scheduled",
      };
      states.push({ event, role, slots, slotUse: new Map(), customerIds: new Set(), untouched: [], count: 0 });
    }
  });

  // --- Bookings
  const drafts: BookingDraft[] = [];

  const createdAt = (event: EventRow): string => {
    // Booked 1 minute to 30 days before whichever is earlier: now, or the event day.
    const latest = Math.min(now.getTime(), Date.parse(`${event.date}T00:00:00Z`));
    return new Date(latest - rng.int(1, 30 * 24 * 60) * 60_000).toISOString();
  };

  const add = (s: EventState, customerId: number, slot: string): BookingDraft => {
    const b: BookingDraft = { event_id: s.event.id, customer_id: customerId, slot, created_at: createdAt(s.event) };
    drafts.push(b);
    s.slotUse.set(slot, (s.slotUse.get(slot) ?? 0) + 1);
    s.customerIds.add(customerId);
    s.count++;
    return b;
  };

  /** n bookings with n different customers in n different slots: no error inside the event itself. */
  const fill = (s: EventState, n: number): void => {
    const people = rng.shuffle(goodIds).slice(0, n);
    const times = rng.shuffle(s.slots).slice(0, n);
    people.forEach((id, i) => s.untouched.push(add(s, id, times[i] as string)));
  };

  const pastSizes = [...ERROR_PLAN.pastEventBookings];
  const cancelledSizes = [...ERROR_PLAN.cancelledEventBookings];
  for (const s of states) {
    if (s.role === "clean") fill(s, s.event.capacity - 4 - rng.int(0, 6)); // leaves ≥ 4 free places
    if (s.role === "past") fill(s, pastSizes.shift() ?? 0);
    if (s.role === "cancelled") fill(s, cancelledSizes.shift() ?? 0);
    if (s.role === "overbooked") fill(s, s.event.capacity + rng.int(1, 2));
  }

  // Injected errors only go into "clean" events that still have a free place, so they never
  // overlap with each other or with the past / cancelled / overbooked events.
  const cleanWithRoom = (): EventState => {
    const options = states.filter((s) => s.role === "clean" && s.count < s.event.capacity && s.untouched.length > 0);
    return rng.pick(options);
  };
  const freeSlot = (s: EventState): string => rng.pick(s.slots.filter((t) => !s.slotUse.has(t)));
  const takeUntouched = (s: EventState): BookingDraft => {
    const b = rng.pick(s.untouched);
    s.untouched = s.untouched.filter((x) => x !== b);
    return b;
  };

  // 1. Duplicate: the same customer books the same event again, in a different free slot.
  for (let i = 0; i < n(ERROR_PLAN.duplicateBookings); i++) {
    const s = cleanWithRoom();
    add(s, takeUntouched(s).customer_id, freeSlot(s));
  }

  // 2. Double-booked slot: a different customer gets a slot that is already taken.
  for (let i = 0; i < n(ERROR_PLAN.doubleBookedSlots); i++) {
    const s = cleanWithRoom();
    const original = takeUntouched(s);
    const stranger = rng.pick(goodIds.filter((id) => !s.customerIds.has(id)));
    add(s, stranger, original.slot);
  }

  // 4. Bad contact data: each bad customer gets one ordinary booking.
  for (const c of bad) {
    const s = cleanWithRoom();
    add(s, c.id, freeSlot(s));
  }

  // Number bookings in the order they were made, so the injected errors aren't simply the last ids.
  const bookings: BookingRow[] = [...drafts]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((b, i) => ({ id: i + 1, ...b, archived_at: null, archive_reason: null }));

  const events = states.map((s) => s.event);
  const past = clean ? 0 : ERROR_PLAN.pastEventBookings.reduce((a, b) => a + b, 0);
  const cancelled = clean ? 0 : ERROR_PLAN.cancelledEventBookings.reduce((a, b) => a + b, 0);

  const expected: ExpectedErrors = {
    rngSeed,
    totals: { cities: CITIES.length, events: events.length, customers: customers.length, bookings: bookings.length },
    errors: {
      duplicateBookings: {
        count: n(ERROR_PLAN.duplicateBookings),
        counts: "(customer, event) pairs with more than one booking",
      },
      doubleBookedSlots: {
        count: n(ERROR_PLAN.doubleBookedSlots),
        counts: "(event, slot) pairs with more than one booking",
      },
      pastOrCancelledEvents: {
        count: past + cancelled,
        past,
        cancelled,
        counts: "bookings on events dated before today or with status 'cancelled'",
      },
      badContacts: {
        count: bad.length,
        counts: "customers whose email or phone is missing, empty or malformed",
        emailRule: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
        phoneRule: "after removing spaces: ^\\+358\\d{7,10}$",
      },
      overbookedEvents: {
        count: n(ERROR_PLAN.overbookedEvents),
        counts: "events with more bookings than capacity",
      },
    },
  };

  return { events, customers, bookings, expected };
}

/**
 * Replaces everything in the database with `data`, inside ONE transaction:
 * if any insert fails, SQLite rolls back the drop and all inserts, and the old data is untouched.
 */
export function seedDatabase(db: Db, data: SeedData): void {
  const run = db.transaction(() => {
    dropSchema(db);
    createSchema(db);
    const insertEvent = db.prepare(
      "INSERT INTO events (id, city, date, time_slots, capacity, status) VALUES (@id, @city, @date, @time_slots, @capacity, @status)",
    );
    const insertCustomer = db.prepare("INSERT INTO customers (id, name, email, phone) VALUES (@id, @name, @email, @phone)");
    const insertBooking = db.prepare(
      "INSERT INTO bookings (id, event_id, customer_id, slot, created_at, archived_at, archive_reason) VALUES (@id, @event_id, @customer_id, @slot, @created_at, @archived_at, @archive_reason)",
    );
    for (const e of data.events) insertEvent.run(e);
    for (const c of data.customers) insertCustomer.run(c);
    for (const b of data.bookings) insertBooking.run(b);
    db.prepare("INSERT INTO audit_log (action, details) VALUES ('seed', ?)").run(JSON.stringify(data.expected.totals));
  });
  run();
}
