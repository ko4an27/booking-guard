import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

describe("project setup", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });

  // Opens a throwaway in-memory database to prove the native better-sqlite3 module loads.
  it("loads better-sqlite3", () => {
    const db = new Database(":memory:");
    const row = db.prepare("SELECT 1 AS one").get() as { one: number };
    expect(row.one).toBe(1);
    db.close();
  });
});
