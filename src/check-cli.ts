// `npm run check` — read-only: finds issues and prints a summary. Add `-- --all` to list every issue.
import { existsSync } from "node:fs";
import { runAllChecks, todayUtc } from "./checks.ts";
import { DEFAULT_DB_PATH, openDb } from "./db.ts";
import { formatSummary } from "./report.ts";

const dbPath = process.env["BOOKING_GUARD_DB"] ?? DEFAULT_DB_PATH;
if (!existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Run \`npm run seed\` first.`);
  process.exit(1);
}

const db = openDb(dbPath);
const today = todayUtc();
const results = runAllChecks(db, today);
db.close();
console.log(formatSummary(results, { today, examples: process.argv.includes("--all") ? Infinity : 3 }));
