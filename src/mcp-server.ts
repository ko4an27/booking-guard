// Booking Guard MCP server: lets Claude Code list issues, propose fixes and (with a human's code) apply them.
// Run with `npm run mcp`; Claude Code starts it automatically through .mcp.json.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, openSync, writeSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAllChecks, todayUtc } from "./checks.ts";
import type { CheckResults, Issue } from "./checks.ts";
import { DEFAULT_DB_PATH, openDb } from "./db.ts";
import type { Db } from "./db.ts";
import { applyFix, confirmationCode, FixError, proposeFix } from "./fixes.ts";
import type { FixProposal } from "./fixes.ts";
import { maskEmail, maskPhone } from "./mask.ts";

export const PROPOSAL_TTL_MS = 15 * 60 * 1000;
export const MAX_WRONG_CODES = 3;

// ---------- Issue ids and masking ----------

/** A stable, readable id for an issue, built from what identifies it (no contact data). */
export function issueId(issue: Issue): string {
  switch (issue.type) {
    case "duplicate_booking":
      return `duplicate_booking:${issue.eventId}:${issue.customerId}`;
    case "double_booked_slot":
      return `double_booked_slot:${issue.eventId}:${issue.slot}`;
    case "past_or_cancelled_event":
      return `past_or_cancelled_event:${issue.bookingId}`;
    case "bad_contact":
      return `bad_contact:${issue.customerId}`;
    case "overbooked_event":
      return `overbooked_event:${issue.eventId}`;
  }
}

/** The issue as the AI may see it: same fields, but emails and phones masked. */
export function maskIssue(issue: Issue): Issue {
  if (issue.type === "duplicate_booking") return { ...issue, email: maskEmail(issue.email) };
  if (issue.type === "bad_contact") return { ...issue, email: maskEmail(issue.email), phone: maskPhone(issue.phone) };
  return issue;
}

/**
 * Safety net run over every tool result before it leaves the server: anything that still looks
 * like an email address or a Finnish phone number is masked. Masked values stay as they are.
 */
export function scrubContactData(text: string): string {
  return text
    .replace(/[^\s"@*]+@[^\s"@]+\.[^\s"@]+/g, (m) => maskEmail(m))
    .replace(/\+358[\d ]{6,14}\d/g, (m) => maskPhone(m));
}

// ---------- The human-only channel for confirmation codes ----------

/**
 * Shows text to the human, never to the AI. Writes straight to the terminal (/dev/tty), which
 * the AI can't read back; if there is no terminal, falls back to stderr. Tool results go over
 * stdout, so neither channel ends up in what Claude sees.
 */
export function showToHumanTerminal(text: string): void {
  const message = `\n${text}\n`;
  try {
    const fd = openSync("/dev/tty", "w");
    writeSync(fd, message);
    closeSync(fd);
  } catch {
    process.stderr.write(message);
  }
}

// ---------- The server ----------

interface StoredProposal {
  id: string;
  issueId: string;
  fix: FixProposal;
  /** Per-proposal key: the code made with it works for this proposal only. */
  key: Uint8Array;
  expiresAt: number;
  wrongCodes: number;
}

export interface ServerOptions {
  db: Db;
  /** Where confirmation codes are shown. Default: the human's terminal. */
  showToHuman?: (text: string) => void;
  /** Secret for confirmation codes. Default: 32 random bytes, kept in memory only. */
  secret?: Uint8Array;
  today?: () => string;
  now?: () => number;
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

/** Every tool returns JSON text, scrubbed of contact data. */
function result(value: unknown): ToolResult {
  return { content: [{ type: "text", text: scrubContactData(JSON.stringify(value, null, 2)) }] };
}

export function createBookingGuardServer(options: ServerOptions): McpServer {
  const { db } = options;
  const showToHuman = options.showToHuman ?? showToHumanTerminal;
  const secret = options.secret ?? randomBytes(32);
  const today = options.today ?? (() => todayUtc());
  const now = options.now ?? (() => Date.now());
  // Proposals live here, on the server. apply_fix takes only an id, so the AI can't send back an edited fix.
  const proposals = new Map<string, StoredProposal>();

  const server = new McpServer({ name: "booking-guard", version: "0.1.0" });

  const allIssues = (): Issue[] => Object.values(runAllChecks(db, today()) as CheckResults).flat();

  // ----- list_issues -----
  server.registerTool(
    "list_issues",
    {
      title: "List data issues",
      description:
        "Runs the 5 data checks (duplicate bookings, double-booked slots, bookings for past or cancelled events, " +
        "bad contact data, overbooked events) and lists the issues found. Read-only. Contact data is masked.",
      inputSchema: { city: z.string().optional().describe("Only issues in this city, e.g. 'Tampere'.") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ city }) => {
      let issues = allIssues();
      if (city !== undefined) {
        const wanted = city.trim().toLowerCase();
        // Bad contacts belong to a customer, not an event: they are "in" a city if they have a booking there.
        const customersInCity = new Set(
          (db
            .prepare(
              `SELECT DISTINCT b.customer_id FROM bookings b JOIN events e ON e.id = b.event_id
                WHERE lower(e.city) = ? AND b.archived_at IS NULL`,
            )
            .all(wanted) as { customer_id: number }[]).map((r) => r.customer_id),
        );
        issues = issues.filter((i) => (i.type === "bad_contact" ? customersInCity.has(i.customerId) : i.city.toLowerCase() === wanted));
      }
      const counts: Record<string, number> = {};
      for (const i of issues) counts[i.type] = (counts[i.type] ?? 0) + 1;
      return result({
        today: today(),
        city: city ?? null,
        total: issues.length,
        counts,
        issues: issues.map((i) => ({ issueId: issueId(i), ...maskIssue(i) })),
      });
    },
  );

  // ----- propose_fix -----
  server.registerTool(
    "propose_fix",
    {
      title: "Propose a fix",
      description:
        "Describes how to fix one issue (by issueId from list_issues). Changes nothing. If the fix can be applied, " +
        "a confirmation code is shown to the HUMAN in their terminal — it is not part of this result. " +
        "Ask the human for the code, then call apply_fix.",
      inputSchema: { issueId: z.string().describe("The issueId from list_issues.") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    ({ issueId: wanted }) => {
      // Re-run the checks: the proposal is always based on the data as it is now.
      const issue = allIssues().find((i) => issueId(i) === wanted);
      if (!issue) return result({ issueId: wanted, found: false, message: "No such issue now (maybe already fixed). Call list_issues again." });

      const fix = proposeFix(db, issue, { today: today() });
      // A new proposal replaces any older one for the same issue, so an old code can't be used.
      for (const [id, p] of proposals) if (p.issueId === wanted) proposals.delete(id);
      if (!fix.fixable) return result({ issueId: wanted, found: true, fixable: false, summary: fix.summary, issue: maskIssue(issue) });

      const id = `P-${randomBytes(4).toString("hex")}`;
      // HMAC of the server secret and the proposal id: a key that exists only for this proposal.
      const key = createHmac("sha256", secret).update(id).digest();
      const stored: StoredProposal = { id, issueId: wanted, fix, key, expiresAt: now() + PROPOSAL_TTL_MS, wrongCodes: 0 };
      proposals.set(id, stored);

      showToHuman(
        [
          "── Booking Guard: confirmation needed ──",
          `Proposal ${id} (${wanted})`,
          fix.summary,
          `Confirmation code: ${confirmationCode(fix, key)}`,
          "Give this code to Claude only if you want this exact fix applied. It expires in 15 minutes.",
        ].join("\n"),
      );

      return result({
        proposalId: id,
        issueId: wanted,
        found: true,
        fixable: true,
        summary: fix.summary,
        changes: fix.changes,
        expiresAt: new Date(stored.expiresAt).toISOString(),
        confirmationCode: "shown to the human in their terminal — not included here",
        next: "Ask the human for the confirmation code. Then call apply_fix with proposalId, confirmationCode and dryRun: false.",
      });
    },
  );

  // ----- apply_fix -----
  server.registerTool(
    "apply_fix",
    {
      title: "Apply a fix",
      description:
        "Applies a proposal from propose_fix. Dry run unless dryRun is false. Needs the confirmation code the human " +
        "was shown. Runs in one transaction and writes audit_log; on any error nothing is changed.",
      inputSchema: {
        proposalId: z.string().describe("The proposalId from propose_fix."),
        confirmationCode: z.string().optional().describe("The code the human read in their terminal."),
        dryRun: z.boolean().optional().describe("Default true: only show what would change."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ proposalId, confirmationCode: code, dryRun }) => {
      const stored = proposals.get(proposalId);
      if (!stored) return result({ proposalId, status: "rejected", reason: "unknown_or_replaced_proposal", message: "Call propose_fix again." });
      if (now() > stored.expiresAt) {
        proposals.delete(proposalId);
        return result({ proposalId, status: "rejected", reason: "expired", message: "Call propose_fix again." });
      }
      if (dryRun ?? true) return result({ proposalId, ...applyFix(db, stored.fix) });

      // The code the AI passes is never echoed back in any result.
      let outcome: ReturnType<typeof applyFix>;
      try {
        outcome = applyFix(db, stored.fix, { dryRun: false, secret: stored.key, ...(code === undefined ? {} : { confirmationCode: code }) });
      } catch (error) {
        // applyFix has already rolled back. The proposal is stale, so it can't be retried.
        proposals.delete(proposalId);
        return result({ proposalId, ...describeFailure(error) });
      }
      if (outcome.status === "rejected") {
        stored.wrongCodes++;
        // 6 characters can be guessed with enough tries, so a proposal is locked after a few wrong codes.
        if (stored.wrongCodes >= MAX_WRONG_CODES) proposals.delete(proposalId);
        return result({
          proposalId,
          status: "rejected",
          reason: outcome.reason,
          attemptsLeft: Math.max(0, MAX_WRONG_CODES - stored.wrongCodes),
        });
      }
      // Applied: the proposal is used up and can never be applied again.
      proposals.delete(proposalId);
      return result({ proposalId, ...outcome });
    },
  );

  return server;
}

/** Turns an error from applyFix (already rolled back) into a message for the AI. */
export function describeFailure(error: unknown): { status: "failed"; message: string } {
  const message = error instanceof FixError ? error.message : `Database error: ${(error as Error).message}`;
  return { status: "failed", message: `${message} Nothing was changed (rolled back).` };
}

// ---------- Start over stdio when run directly ----------

async function main(): Promise<void> {
  // Resolve the database relative to the project, not to whatever folder Claude Code starts us in.
  const projectRoot = fileURLToPath(new URL("..", import.meta.url));
  const dbPath = process.env["BOOKING_GUARD_DB"] ?? resolve(projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    process.stderr.write(`booking-guard: no database at ${dbPath}. Run \`npm run seed\` first.\n`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  const server = createBookingGuardServer({ db });
  // stdout carries the MCP protocol, so nothing else may be printed there.
  await server.connect(new StdioServerTransport());
  process.stderr.write(`booking-guard MCP server ready (${dbPath})\n`);
  const close = () => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`booking-guard: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
