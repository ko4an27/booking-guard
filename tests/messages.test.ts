import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAllChecks } from "../src/checks.ts";
import type { Issue } from "../src/checks.ts";
import { createSchema, openDb } from "../src/db.ts";
import type { CustomerRow, Db } from "../src/db.ts";
import { applyFix, confirmationCode, proposeFix } from "../src/fixes.ts";
import { draftMessages, firstName, formatDateEn, formatDateFi, renderDraft } from "../src/messages.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";

const TODAY = "2026-11-02";
const SECRET = new TextEncoder().encode("test-secret");
let db: Db;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: new Date(`${TODAY}T12:00:00Z`) }));
  dir = mkdtempSync(join(tmpdir(), "bg-drafts-"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const applyIssue = (d: Db, issue: Issue) => {
  const fix = proposeFix(d, issue, { today: TODAY });
  return applyFix(d, fix, { dryRun: false, secret: SECRET, confirmationCode: confirmationCode(fix, SECRET) });
};

/** Apply every fixable issue, re-checking after each fix (like the morning routine). */
function fixEverything(d: Db = db): void {
  for (let i = 0; i < 100; i++) {
    const issue = Object.values(runAllChecks(d, TODAY)).flat().find((x: Issue) => proposeFix(d, x, { today: TODAY }).fixable);
    if (!issue) return;
    applyIssue(d, issue);
  }
}

/** Customers with at least one applied change that needs a message. */
const affectedCustomers = (d: Db = db): number[] =>
  (d
    .prepare(
      `SELECT DISTINCT json_extract(details, '$.change.customerId') AS c FROM audit_log
        WHERE json_extract(details, '$.needsMessage') = 1 ORDER BY c`,
    )
    .all() as { c: number }[]).map((r) => r.c);

const files = () => readdirSync(dir).sort();
const read = (f: string) => readFileSync(join(dir, f), "utf8");

describe("text helpers", () => {
  it("formats dates in Finnish and English", () => {
    expect(formatDateFi("2026-12-05")).toBe("5.12.2026");
    expect(formatDateEn("2026-12-05")).toBe("5 December 2026");
  });

  it("takes the first name", () => {
    expect(firstName("Matti Virtanen")).toBe("Matti");
    expect(firstName("  Liisa   Laine ")).toBe("Liisa");
    expect(firstName("")).toBe("");
  });

  it("renders a polite draft in both languages with time, place and contact, and masked contact data only", () => {
    const text = renderDraft(
      { id: 7, name: "Anna Korhonen", email: "anna.korhonen7@example.com", phone: "+358 40 123 4567" },
      [
        { kind: "moved_slot", city: "Oulu", date: "2026-12-05", fromSlot: "10:00", toSlot: "11:20" },
        { kind: "moved_event", city: "Oulu", fromDate: "2026-12-05", toDate: "2026-12-19", toSlot: "10:40" },
        { kind: "waitlist", city: "Oulu", date: "2026-12-05" },
      ],
      [1, 2, 3],
    );
    expect(text).toContain("## Suomeksi");
    expect(text).toContain("## In English");
    expect(text).toContain("Hei Anna,");
    expect(text).toContain("Hello Anna,");
    expect(text).toContain("Uusi aika: klo 11:20 (aiemmin klo 10:00)");
    expect(text).toContain("New time: 11:20 (previously 10:00)");
    expect(text).toContain("Päivä: 19.12.2026");
    expect(text).toContain("Date: 19 December 2026");
    expect(text).toContain("jonotuslistalla");
    expect(text).toContain("waiting list");
    expect(text).toContain("vastaa tähän viestiin");
    expect(text).toContain("reply to this message");
    expect(text).toContain("Nothing has been sent");
    expect(text).not.toContain("Korhonen");
    expect(text).not.toContain("anna.korhonen7@example.com");
    expect(text).not.toContain("+358 40 123 4567");
    expect(text).toContain("a***@example.com");
  });

  it("greets without a name if there is none", () => {
    const text = renderDraft({ id: 1, name: " ", email: null, phone: null }, [{ kind: "waitlist", city: "Oulu", date: "2026-12-05" }], [1]);
    expect(text).toContain("Hei,");
    expect(text).toContain("Hello,");
  });
});

describe("draftMessages", () => {
  it("writes nothing when no change needs a message", () => {
    expect(draftMessages(db, { draftsDir: dir })).toEqual({ created: [], alreadyDrafted: 0 });
    expect(files()).toEqual([]);
  });

  it("writes exactly one draft per affected customer, in both languages", () => {
    fixEverything();
    const affected = affectedCustomers();
    expect(affected.length).toBeGreaterThan(10); // 9 double-booked moves + the overbooked moves
    const run = draftMessages(db, { draftsDir: dir });
    expect(run.created.map((d) => d.customerId).sort((a, b) => a - b)).toEqual(affected);
    expect(files()).toHaveLength(affected.length);
    for (const f of files()) {
      expect(read(f)).toContain("## Suomeksi");
      expect(read(f)).toContain("## In English");
    }
  });

  it("writes no draft for customers whose change needs no message (archived duplicates and past bookings)", () => {
    fixEverything();
    draftMessages(db, { draftsDir: dir });
    const archivedOnly = (db
      .prepare(
        `SELECT DISTINCT customer_id AS c FROM bookings WHERE archived_at IS NOT NULL
           AND customer_id NOT IN (SELECT json_extract(details, '$.change.customerId') FROM audit_log
                                    WHERE json_extract(details, '$.needsMessage') = 1)`,
      )
      .all() as { c: number }[]).map((r) => r.c);
    expect(archivedOnly.length).toBeGreaterThan(0);
    for (const c of archivedOnly) expect(files().some((f) => f.startsWith(`customer-${c}-`))).toBe(false);
  });

  it("running it twice creates no duplicates", () => {
    fixEverything();
    const first = draftMessages(db, { draftsDir: dir });
    const before = files();
    const second = draftMessages(db, { draftsDir: dir });
    expect(second.created).toEqual([]);
    expect(second.alreadyDrafted).toBe(first.created.reduce((n, d) => n + d.auditLogIds.length, 0));
    expect(files()).toEqual(before);
  });

  it("a later change gets a new draft for that customer only", () => {
    applyIssue(db, runAllChecks(db, TODAY).doubleBookedSlots[0] as Issue);
    const first = draftMessages(db, { draftsDir: dir });
    expect(first.created).toHaveLength(1);
    applyIssue(db, runAllChecks(db, TODAY).doubleBookedSlots[0] as Issue);
    const second = draftMessages(db, { draftsDir: dir });
    expect(second.created).toHaveLength(1);
    expect(second.created[0]?.customerId).not.toBe(first.created[0]?.customerId);
    expect(files()).toHaveLength(2);
  });

  it("puts several changes of one customer into ONE draft", () => {
    applyIssue(db, runAllChecks(db, TODAY).doubleBookedSlots[0] as Issue);
    const row = db.prepare("SELECT details FROM audit_log WHERE action = 'move_booking'").get() as { details: string };
    const { change } = JSON.parse(row.details) as { change: { customerId: number; bookingId: number } };
    // A second change for the same customer (as if their booking was later waitlisted).
    const b = db.prepare("SELECT event_id FROM bookings WHERE id = ?").get(change.bookingId) as { event_id: number };
    db.prepare("INSERT INTO audit_log (action, details) VALUES ('waitlist_booking', ?)").run(
      JSON.stringify({
        issueType: "overbooked_event",
        change: { op: "waitlist_booking", bookingId: change.bookingId, customerId: change.customerId, eventId: b.event_id },
        needsMessage: true,
      }),
    );
    const run = draftMessages(db, { draftsDir: dir });
    expect(run.created).toHaveLength(1);
    expect(run.created[0]?.auditLogIds).toHaveLength(2);
    const text = read(files()[0] as string);
    expect(text).toContain("Uusi aika");
    expect(text).toContain("jonotuslistalla");
  });

  it("drafts for waitlisted customers", () => {
    const d = openDb(":memory:");
    createSchema(d);
    d.exec(`
      INSERT INTO events (id, city, date, time_slots, capacity) VALUES (1, 'Kuopio', '2026-12-01', '["10:00","10:20"]', 1);
      INSERT INTO customers (id, name, email, phone) VALUES (1, 'Satu Niemi', 'satu@example.com', '+358 40 111 2233'),
                                                           (2, 'Timo Laine', 'timo@example.com', '+358 40 444 5566');
      INSERT INTO bookings (event_id, customer_id, slot, created_at) VALUES (1, 1, '10:00', '2026-10-01'), (1, 2, '10:20', '2026-10-02');
    `);
    applyIssue(d, runAllChecks(d, TODAY).overbookedEvents[0] as Issue); // no later event → waitlist
    const run = draftMessages(d, { draftsDir: dir });
    expect(run.created.map((x) => x.customerId)).toEqual([2]);
    const text = read(files()[0] as string);
    expect(text).toContain("Hei Timo,");
    expect(text).toContain("Kuopio, 1.12.2026");
    expect(text).toContain("waiting list");
    d.close();
  });

  it("never puts a full email or phone number in any draft", () => {
    fixEverything();
    draftMessages(db, { draftsDir: dir });
    const all = files().map(read).join("\n");
    for (const c of db.prepare("SELECT email, phone FROM customers").all() as CustomerRow[]) {
      if (c.email && c.email.length > 3) expect(all).not.toContain(c.email);
      if (c.phone && c.phone.length > 4) expect(all).not.toContain(c.phone);
    }
    expect(all).not.toMatch(/\+358 \d{2} \d{3}/);
  });

  it("records what it drafted in message_drafts and audit_log", () => {
    fixEverything();
    const run = draftMessages(db, { draftsDir: dir });
    const marked = (db.prepare("SELECT COUNT(*) AS n FROM message_drafts").get() as { n: number }).n;
    expect(marked).toBe(run.created.reduce((n, d) => n + d.auditLogIds.length, 0));
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'draft_messages'").get() as { n: number }).n).toBe(1);
  });
});
