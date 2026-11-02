import { openSync, closeSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAllChecks } from "../src/checks.ts";
import type { Issue } from "../src/checks.ts";
import { openDb } from "../src/db.ts";
import type { CustomerRow, Db } from "../src/db.ts";
import { FixError } from "../src/fixes.ts";
import {
  createBookingGuardServer,
  describeFailure,
  issueId,
  maskIssue,
  MAX_WRONG_CODES,
  PROPOSAL_TTL_MS,
  scrubContactData,
  showToHumanTerminal,
} from "../src/mcp-server.ts";
import { generateSeedData, seedDatabase } from "../src/seed.ts";

const TODAY = "2026-11-02";
type Json = Record<string, unknown>;

let db: Db;
let client: Client;
let clock: number;
/** What the human saw in their terminal. */
let humanMessages: string[];
/** The raw text of every tool result the AI received. */
let toolResults: string[];

beforeEach(async () => {
  db = openDb(":memory:");
  seedDatabase(db, generateSeedData({ now: new Date(`${TODAY}T12:00:00Z`) }));
  humanMessages = [];
  toolResults = [];
  clock = Date.parse(`${TODAY}T12:00:00Z`);
  const server = createBookingGuardServer({
    db,
    showToHuman: (text) => humanMessages.push(text),
    secret: new TextEncoder().encode("test-secret"),
    today: () => TODAY,
    now: () => clock,
  });
  // Two transports wired to each other in memory: the same protocol Claude Code speaks over stdio.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
});
afterEach(async () => {
  await client.close();
  db.close();
});

async function call(name: string, args: Json = {}): Promise<Json> {
  const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  const text = res.content.map((c) => c.text).join("\n");
  toolResults.push(text);
  expect(res.isError ?? false).toBe(false);
  return JSON.parse(text) as Json;
}

/** The code shown to the human for a proposal (read from "their terminal"). */
function codeFor(proposalId: string): string {
  const msg = humanMessages.findLast((m) => m.includes(`Proposal ${proposalId} `));
  const code = msg?.match(/Confirmation code: ([0-9A-F]{6})/)?.[1];
  if (!code) throw new Error(`no code shown for ${proposalId}`);
  return code;
}

function snapshot(): Record<string, unknown[]> {
  return Object.fromEntries(
    ["events", "customers", "bookings", "audit_log"].map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]),
  );
}

const allIssues = (): Issue[] => Object.values(runAllChecks(db, TODAY)).flat();
const firstId = (type: Issue["type"]) => {
  const issue = allIssues().find((i) => i.type === type);
  if (!issue) throw new Error(`no ${type}`);
  return issueId(issue);
};
const allCodesShown = () => humanMessages.map((m) => m.match(/Confirmation code: ([0-9A-F]{6})/)?.[1]).filter((c): c is string => !!c);

describe("tools", () => {
  it("offers list_issues, propose_fix and apply_fix; only apply_fix is marked destructive", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["apply_fix", "list_issues", "propose_fix"]);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName["apply_fix"]?.annotations?.destructiveHint).toBe(true);
    expect(byName["list_issues"]?.annotations?.readOnlyHint).toBe(true);
    expect(byName["propose_fix"]?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("list_issues", () => {
  it("lists all 51 seeded issues with ids and counts", async () => {
    const res = await call("list_issues");
    expect(res["total"]).toBe(51);
    expect(res["counts"]).toEqual({
      duplicate_booking: 12,
      double_booked_slot: 9,
      past_or_cancelled_event: 15,
      bad_contact: 11,
      overbooked_event: 4,
    });
    const ids = (res["issues"] as Json[]).map((i) => i["issueId"]);
    expect(new Set(ids).size).toBe(51);
  });

  it("filters by city (case-insensitive), including bad contacts of customers booked there", async () => {
    const res = await call("list_issues", { city: "tampere" });
    const issues = res["issues"] as Json[];
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) {
      if (i["type"] === "bad_contact") {
        const n = db
          .prepare("SELECT COUNT(*) AS n FROM bookings b JOIN events e ON e.id = b.event_id WHERE b.customer_id = ? AND e.city = 'Tampere'")
          .get(i["customerId"]) as { n: number };
        expect(n.n).toBeGreaterThan(0);
      } else {
        expect(i["city"]).toBe("Tampere");
      }
    }
    // Every city's issues together = all issues (each issue belongs to exactly one city in the seed).
    let sum = 0;
    for (const city of ["Helsinki", "Espoo", "Tampere", "Vantaa", "Oulu", "Turku", "Jyväskylä", "Kuopio"]) {
      sum += (await call("list_issues", { city }))["total"] as number;
    }
    expect(sum).toBe(51);
  });

  it("returns nothing for an unknown city", async () => {
    expect((await call("list_issues", { city: "Atlantis" }))["total"]).toBe(0);
  });
});

describe("propose_fix", () => {
  it("changes nothing and shows the code to the human only", async () => {
    const before = snapshot();
    const res = await call("propose_fix", { issueId: firstId("duplicate_booking") });
    expect(snapshot()).toEqual(before);
    expect(res["fixable"]).toBe(true);
    expect(humanMessages).toHaveLength(1);
    const code = codeFor(res["proposalId"] as string);
    expect(JSON.stringify(res)).not.toContain(code);
  });

  it("shows no code for an issue that can't be fixed automatically", async () => {
    const res = await call("propose_fix", { issueId: firstId("bad_contact") });
    expect(res["fixable"]).toBe(false);
    expect(res["proposalId"]).toBeUndefined();
    expect(humanMessages).toEqual([]);
  });

  it("reports an unknown issue", async () => {
    expect((await call("propose_fix", { issueId: "duplicate_booking:999:999" }))["found"]).toBe(false);
  });
});

describe("apply_fix", () => {
  async function propose(type: Issue["type"] = "duplicate_booking"): Promise<string> {
    return (await call("propose_fix", { issueId: firstId(type) }))["proposalId"] as string;
  }

  it("is a dry run by default — even with the right code", async () => {
    const id = await propose();
    const before = snapshot();
    expect((await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id) }))["status"]).toBe("dry_run");
    expect(snapshot()).toEqual(before);
  });

  it("applies with the right code, writes audit_log, and can't be applied twice", async () => {
    const id = await propose();
    const auditBefore = (db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const res = await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id), dryRun: false });
    expect(res["status"]).toBe("applied");
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n).toBeGreaterThan(auditBefore);
    const before = snapshot();
    expect((await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id), dryRun: false }))["reason"]).toBe(
      "unknown_or_replaced_proposal",
    );
    expect(snapshot()).toEqual(before);
  });

  it("with a wrong code or no code changes nothing", async () => {
    const id = await propose();
    const before = snapshot();
    expect(await call("apply_fix", { proposalId: id, confirmationCode: "000000", dryRun: false })).toMatchObject({
      status: "rejected",
      reason: "wrong_confirmation_code",
    });
    expect(await call("apply_fix", { proposalId: id, dryRun: false })).toMatchObject({ status: "rejected" });
    expect(snapshot()).toEqual(before);
  });

  it("with an OLD code changes nothing: re-proposing the same issue makes the old proposal and code useless", async () => {
    const oldId = await propose();
    const oldCode = codeFor(oldId);
    const newId = await propose(); // same issue, same changes — but a new proposal with a new code
    const newCode = codeFor(newId);
    expect(newCode).not.toBe(oldCode);
    const before = snapshot();
    expect((await call("apply_fix", { proposalId: oldId, confirmationCode: oldCode, dryRun: false }))["status"]).toBe("rejected");
    expect((await call("apply_fix", { proposalId: newId, confirmationCode: oldCode, dryRun: false }))["status"]).toBe("rejected");
    expect(snapshot()).toEqual(before);
    // The new code still works.
    expect((await call("apply_fix", { proposalId: newId, confirmationCode: newCode, dryRun: false }))["status"]).toBe("applied");
  });

  it("with the code of a DIFFERENT proposal changes nothing", async () => {
    const a = await propose("duplicate_booking");
    const b = await propose("past_or_cancelled_event");
    const before = snapshot();
    expect((await call("apply_fix", { proposalId: a, confirmationCode: codeFor(b), dryRun: false }))["status"]).toBe("rejected");
    expect(snapshot()).toEqual(before);
  });

  it(`locks a proposal after ${MAX_WRONG_CODES} wrong codes`, async () => {
    const id = await propose();
    for (let i = 0; i < MAX_WRONG_CODES; i++) await call("apply_fix", { proposalId: id, confirmationCode: "000000", dryRun: false });
    const before = snapshot();
    expect((await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id), dryRun: false }))["status"]).toBe("rejected");
    expect(snapshot()).toEqual(before);
  });

  it("refuses an expired proposal", async () => {
    const id = await propose();
    clock += PROPOSAL_TTL_MS + 1;
    const before = snapshot();
    expect(await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id), dryRun: false })).toMatchObject({ reason: "expired" });
    expect(snapshot()).toEqual(before);
  });

  it("reports a stale proposal as failed and changes nothing (rollback)", async () => {
    const id = await propose("overbooked_event");
    // Someone else changes the data after the proposal: one of the bookings to move is archived.
    const issue = allIssues().find((i) => i.type === "overbooked_event");
    if (issue?.type !== "overbooked_event") throw new Error("no overbooked event");
    db.prepare(
      `UPDATE bookings SET archived_at = 'x', archive_reason = 'duplicate'
        WHERE id = (SELECT id FROM bookings WHERE event_id = ? ORDER BY created_at DESC LIMIT 1)`,
    ).run(issue.eventId);
    const before = snapshot();
    const res = await call("apply_fix", { proposalId: id, confirmationCode: codeFor(id), dryRun: false });
    expect(res["status"]).toBe("failed");
    expect(res["message"]).toMatch(/rolled back/);
    expect(snapshot()).toEqual(before);
  });
});

describe("what the AI sees", () => {
  /** Exercise every tool on every issue: list, propose all, dry runs, wrong codes, a real apply. */
  async function fullSession(): Promise<void> {
    await call("list_issues");
    await call("list_issues", { city: "Oulu" });
    const ids: string[] = [];
    for (const issue of allIssues()) {
      const res = await call("propose_fix", { issueId: issueId(issue) });
      if (typeof res["proposalId"] === "string") ids.push(res["proposalId"]);
    }
    for (const id of ids.slice(0, 5)) {
      await call("apply_fix", { proposalId: id });
      await call("apply_fix", { proposalId: id, confirmationCode: "000000", dryRun: false });
    }
    const last = ids.at(-1) as string;
    await call("apply_fix", { proposalId: last, confirmationCode: codeFor(last), dryRun: false });
  }

  it("the confirmation code never appears in any tool result", async () => {
    await fullSession();
    const codes = allCodesShown();
    expect(codes.length).toBeGreaterThan(30); // one per fixable issue
    for (const text of toolResults) for (const code of codes) expect(text).not.toContain(code);
    // Also not in the database the AI could read.
    const audit = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    for (const code of codes) expect(audit).not.toContain(code);
  });

  it("no tool result contains an unmasked email or phone number", async () => {
    await fullSession();
    const customers = db.prepare("SELECT email, phone FROM customers").all() as CustomerRow[];
    const all = toolResults.join("\n");
    for (const c of customers) {
      if (c.email && c.email.length > 3) expect(all).not.toContain(c.email);
      if (c.phone && c.phone.length > 4) expect(all).not.toContain(c.phone);
    }
    expect(all).not.toMatch(/\+358 ?\d{2} ?\d{3}/); // no phone-number shapes at all
    expect(all).toMatch(/\w\*\*\*@example\.com/); // masked addresses are there
  });
});

describe("helpers", () => {
  it("issueId is unique for every seeded issue", () => {
    const ids = allIssues().map(issueId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maskIssue masks email and phone and keeps the rest", () => {
    const issue: Issue = { type: "bad_contact", customerId: 1, email: "anna@example.com", phone: "+358 40 123 4512", problems: [], bookingCount: 1 };
    expect(maskIssue(issue)).toEqual({ ...issue, email: "a***@example.com", phone: "+358 *** ** 12" });
    const over: Issue = { type: "overbooked_event", eventId: 1, city: "Oulu", date: "2026-12-01", capacity: 1, booked: 2 };
    expect(maskIssue(over)).toBe(over);
  });

  it("scrubContactData masks anything that looks like an email or Finnish phone, and leaves masked values alone", () => {
    expect(scrubContactData('{"e":"matti.virtanen@example.com","p":"+358 40 123 4567"}')).toBe('{"e":"m***@example.com","p":"+358 *** ** 67"}');
    expect(scrubContactData('"a***@example.com" "+358 *** ** 12"')).toBe('"a***@example.com" "+358 *** ** 12"');
    expect(scrubContactData("booking 12 at 10:00 on 2026-12-01")).toBe("booking 12 at 10:00 on 2026-12-01");
  });

  it("describeFailure says nothing was changed", () => {
    expect(describeFailure(new FixError("stale."))).toEqual({ status: "failed", message: "stale. Nothing was changed (rolled back)." });
    expect(describeFailure(new Error("CHECK failed")).message).toMatch(/^Database error: CHECK failed/);
  });

  it("showToHumanTerminal writes to the terminal, or to stderr if there is none — never to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let hasTty = true;
    try {
      closeSync(openSync("/dev/tty", "w"));
    } catch {
      hasTty = false;
    }
    showToHumanTerminal("Confirmation code: ABC123");
    expect(stdout).not.toHaveBeenCalled();
    if (!hasTty) expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ABC123"));
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
