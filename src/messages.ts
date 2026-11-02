// Customer message drafts (CLAUDE.md rule 6): written to files in drafts/ only. Nothing is ever sent.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomerRow, Db, EventRow } from "./db.ts";
import type { Change } from "./fixes.ts";
import { maskEmail, maskPhone } from "./mask.ts";

/** One change in a customer's booking, with what the message needs to say. */
export type DraftItem =
  | { kind: "moved_slot"; city: string; date: string; fromSlot: string; toSlot: string }
  | { kind: "moved_event"; city: string; fromDate: string; toDate: string; toSlot: string }
  | { kind: "waitlist"; city: string; date: string };

export interface CreatedDraft {
  customerId: number;
  /** File name inside the drafts folder. */
  file: string;
  auditLogIds: number[];
}

export interface DraftRun {
  created: CreatedDraft[];
  /** Changes that already had a draft from an earlier run (skipped). */
  alreadyDrafted: number;
}

// ---------- Text ----------

/** "2026-12-12" → "12.12.2026" (the Finnish way). */
export function formatDateFi(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)}.${Number(m)}.${y}`;
}

/** "2026-12-12" → "12 December 2026". */
export function formatDateEn(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** First word of the name; empty if there is none. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

function itemFi(i: DraftItem): string {
  switch (i.kind) {
    case "moved_slot":
      return [
        "Aikasi kullan arviointitilaisuudessa on muuttunut, koska samalle ajalle oli vahingossa varattu kaksi asiakasta.",
        `  Paikka: ${i.city}`,
        `  Päivä: ${formatDateFi(i.date)}`,
        `  Uusi aika: klo ${i.toSlot} (aiemmin klo ${i.fromSlot})`,
      ].join("\n");
    case "moved_event":
      return [
        `Alkuperäinen tilaisuus (${i.city}, ${formatDateFi(i.fromDate)}) oli ylivarattu, joten siirsimme varauksesi seuraavaan tilaisuuteen samassa kaupungissa.`,
        `  Paikka: ${i.city}`,
        `  Päivä: ${formatDateFi(i.toDate)}`,
        `  Aika: klo ${i.toSlot}`,
      ].join("\n");
    case "waitlist":
      return `Tilaisuus (${i.city}, ${formatDateFi(i.date)}) on valitettavasti täynnä. Olet nyt jonotuslistalla, ja ilmoitamme sinulle heti, jos paikka vapautuu.`;
  }
}

function itemEn(i: DraftItem): string {
  switch (i.kind) {
    case "moved_slot":
      return [
        "Your appointment time at the gold valuation event has changed, because two customers had been booked for the same time by mistake.",
        `  Place: ${i.city}`,
        `  Date: ${formatDateEn(i.date)}`,
        `  New time: ${i.toSlot} (previously ${i.fromSlot})`,
      ].join("\n");
    case "moved_event":
      return [
        `The original event (${i.city}, ${formatDateEn(i.fromDate)}) was overbooked, so we have moved your booking to the next event in the same city.`,
        `  Place: ${i.city}`,
        `  Date: ${formatDateEn(i.toDate)}`,
        `  Time: ${i.toSlot}`,
      ].join("\n");
    case "waitlist":
      return `Unfortunately the event (${i.city}, ${formatDateEn(i.date)}) is full. You are now on the waiting list, and we will let you know right away if a place becomes available.`;
  }
}

/**
 * The full draft: a header for the human (masked contact data), then the message in Finnish and
 * in English. The message itself uses only the first name — never an email or phone number.
 */
export function renderDraft(customer: Pick<CustomerRow, "id" | "name" | "email" | "phone">, items: DraftItem[], auditLogIds: number[]): string {
  const name = firstName(customer.name);
  return [
    `# Message draft: customer ${customer.id}`,
    "",
    "> DRAFT ONLY. Nothing has been sent. Review it, then send it yourself.",
    `> Customer ${customer.id} · email ${maskEmail(customer.email)} · phone ${maskPhone(customer.phone)} · audit_log ${auditLogIds.join(", ")}`,
    "",
    "## Suomeksi",
    "",
    "Aihe: Varauksesi on muuttunut",
    "",
    name ? `Hei ${name},` : "Hei,",
    "",
    items.map(itemFi).join("\n\n"),
    "",
    "Pahoittelemme muutoksesta aiheutuvaa vaivaa. Jos aika ei sovi sinulle tai sinulla on kysyttävää, vastaa tähän viestiin, niin autamme mielellämme.",
    "",
    "Ystävällisin terveisin",
    "Asiakaspalvelu",
    "",
    "## In English",
    "",
    "Subject: Your booking has changed",
    "",
    name ? `Hello ${name},` : "Hello,",
    "",
    items.map(itemEn).join("\n\n"),
    "",
    "We apologise for the inconvenience. If the new time doesn't suit you or you have any questions, just reply to this message and we'll be happy to help.",
    "",
    "Kind regards",
    "Customer service",
    "",
  ].join("\n");
}

// ---------- Reading the changes ----------

interface PendingChange {
  auditLogId: number;
  change: Change;
}

const eventById = (db: Db, id: number) => db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRow | undefined;

/** Turns one audit_log change into what the customer needs to hear. */
function toItem(db: Db, change: Change): DraftItem | null {
  switch (change.op) {
    case "move_booking": {
      // The change doesn't store the event; the booking still belongs to it.
      const b = db.prepare("SELECT event_id FROM bookings WHERE id = ?").get(change.bookingId) as { event_id: number } | undefined;
      const e = b && eventById(db, b.event_id);
      return e ? { kind: "moved_slot", city: e.city, date: e.date, fromSlot: change.fromSlot, toSlot: change.toSlot } : null;
    }
    case "move_to_event": {
      const from = eventById(db, change.fromEventId);
      const to = eventById(db, change.toEventId);
      return from && to ? { kind: "moved_event", city: to.city, fromDate: from.date, toDate: to.date, toSlot: change.toSlot } : null;
    }
    case "waitlist_booking": {
      const e = eventById(db, change.eventId);
      return e ? { kind: "waitlist", city: e.city, date: e.date } : null;
    }
    case "archive_booking":
      return null;
  }
}

// ---------- draftMessages ----------

/**
 * Writes one draft per customer for every audit_log change marked needsMessage that has no draft yet.
 * Changes already drafted (listed in message_drafts) are skipped, so running it twice creates nothing new.
 */
export function draftMessages(db: Db, options: { draftsDir: string }): DraftRun {
  // LEFT JOIN + "m.id IS NULL" = the audit rows that have NO matching row in message_drafts yet.
  const rows = db
    .prepare(
      `SELECT a.id, a.details, m.id AS drafted
         FROM audit_log a
         LEFT JOIN message_drafts m ON m.audit_log_id = a.id
        WHERE json_extract(a.details, '$.needsMessage') = 1
        ORDER BY a.id`,
    )
    .all() as Array<{ id: number; details: string; drafted: number | null }>;

  const byCustomer = new Map<number, PendingChange[]>();
  for (const r of rows) {
    if (r.drafted !== null) continue;
    const change = (JSON.parse(r.details) as { change: Change }).change;
    if (change.op === "archive_booking") continue;
    const list = byCustomer.get(change.customerId) ?? [];
    list.push({ auditLogId: r.id, change });
    byCustomer.set(change.customerId, list);
  }

  const created: CreatedDraft[] = [];
  mkdirSync(options.draftsDir, { recursive: true });
  for (const [customerId, changes] of byCustomer) {
    const customer = db.prepare("SELECT id, name, email, phone FROM customers WHERE id = ?").get(customerId) as CustomerRow | undefined;
    if (!customer) continue;
    const items = changes.map((c) => toItem(db, c.change)).filter((i): i is DraftItem => i !== null);
    if (items.length === 0) continue;
    const auditLogIds = changes.map((c) => c.auditLogId);
    const text = renderDraft(customer, items, auditLogIds);
    // Last line of defense for rule 4: the full email or phone must never be in a draft.
    for (const secretValue of [customer.email, customer.phone]) {
      if (secretValue && secretValue.length > 3 && text.includes(secretValue)) throw new Error(`Draft for customer ${customerId} contains contact data`);
    }
    // The name depends only on the customer and the newest change, so a retry overwrites instead of duplicating.
    const file = `customer-${customerId}-a${Math.max(...auditLogIds)}.md`;
    writeFileSync(join(options.draftsDir, file), text);
    created.push({ customerId, file, auditLogIds });
  }

  // Record what was drafted (and log it) in one transaction: all of it or none of it.
  db.transaction(() => {
    const mark = db.prepare("INSERT INTO message_drafts (audit_log_id, customer_id, file) VALUES (?, ?, ?)");
    for (const d of created) for (const id of d.auditLogIds) mark.run(id, d.customerId, d.file);
    if (created.length > 0) {
      db.prepare("INSERT INTO audit_log (action, details) VALUES ('draft_messages', ?)").run(
        JSON.stringify({ drafts: created.map((d) => ({ customerId: d.customerId, file: d.file, auditLogIds: d.auditLogIds })) }),
      );
    }
  })();

  return { created, alreadyDrafted: rows.filter((r) => r.drafted !== null).length };
}
