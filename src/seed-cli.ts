// `npm run seed`: recreate the database with fresh fake data and write the expected error counts.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_DB_PATH, openDb } from "./db.ts";
import { generateSeedData, seedDatabase } from "./seed.ts";

const dbPath = process.env["BOOKING_GUARD_DB"] ?? DEFAULT_DB_PATH;
const expectedPath = "tests/expected.json";

mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const data = generateSeedData({ now: new Date() });
seedDatabase(db, data);
db.close();
writeFileSync(expectedPath, `${JSON.stringify(data.expected, null, 2)}\n`);

// Only counts are printed, never customer data.
const { totals, errors } = data.expected;
console.log(`Seeded ${dbPath}: ${totals.events} events, ${totals.customers} customers, ${totals.bookings} bookings`);
for (const [name, e] of Object.entries(errors)) console.log(`  ${name}: ${e.count}`);
console.log(`Expected counts written to ${expectedPath}`);
