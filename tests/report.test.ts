import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAllChecks } from "../src/checks.ts";
import type { Issue } from "../src/checks.ts";
import { openDb } from "../src/db.ts";
import type { CustomerRow, Db } from "../src/db.ts";
import { describeIssue, formatSummary } from "../src/report.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";

const TODAY = "2026-11-02";
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: new Date(`${TODAY}T12:00:00Z`) }));
});
afterEach(() => db.close());

describe("formatSummary", () => {
  it("shows every check with its count and a total", () => {
    const text = formatSummary(runAllChecks(db, TODAY), { today: TODAY });
    expect(text).toContain("Duplicate bookings: 12");
    expect(text).toContain("Double-booked slots: 9");
    expect(text).toContain("Bookings for past or cancelled events: 15");
    expect(text).toContain("Empty or malformed contact data: 11");
    expect(text).toContain("Overbooked events: 4");
    expect(text).toContain("Total: 51 issues");
    expect(text).toContain("… and 9 more");
  });

  it("never contains a real email or phone number, even when listing every issue (rule 4)", () => {
    const text = formatSummary(runAllChecks(db, TODAY), { today: TODAY, examples: Infinity });
    const customers = db.prepare("SELECT email, phone FROM customers").all() as CustomerRow[];
    for (const c of customers) {
      if (c.email && c.email.length > 3) expect(text).not.toContain(c.email);
      if (c.phone && c.phone.length > 4) expect(text).not.toContain(c.phone);
    }
    expect(text).toMatch(/\w\*\*\*@example\.com/);
  });

  it("says so when there are no issues", () => {
    const empty = { duplicateBookings: [], doubleBookedSlots: [], pastOrCancelledEvents: [], badContacts: [], overbookedEvents: [] };
    expect(formatSummary(empty, { today: TODAY })).toContain("No issues found.");
  });
});

describe("describeIssue", () => {
  it("masks contact data in a bad-contact line", () => {
    const issue: Issue = {
      type: "bad_contact",
      customerId: 5,
      email: "anna.virtanen@example",
      phone: "+358 40 123 4512",
      problems: ["email_malformed"],
      bookingCount: 1,
    };
    expect(describeIssue(issue)).toBe(
      "customer 5: email a***@example, phone +358 *** ** 12 — email_malformed (1 booking)",
    );
  });

  it("describes an overbooked event", () => {
    expect(
      describeIssue({ type: "overbooked_event", eventId: 2, city: "Oulu", date: "2026-12-01", capacity: 18, booked: 20 }),
    ).toBe("event 2 (Oulu 2026-12-01): 20 bookings for capacity 18 (+2)");
  });
});
