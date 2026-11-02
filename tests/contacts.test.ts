import { describe, expect, it } from "vitest";
import { contactProblems, isValidEmail, isValidPhone } from "../src/contacts.ts";

describe("isValidEmail", () => {
  it.each(["anna@example.com", "matti.virtanen12@example.com", "a@b.fi"])("accepts %s", (e) => {
    expect(isValidEmail(e)).toBe(true);
  });
  it.each([null, "", "anna.example.com", "anna@", "anna@example", "an na@example.com", "anna@@example.com"])(
    "rejects %s",
    (e) => expect(isValidEmail(e)).toBe(false),
  );
});

describe("isValidPhone", () => {
  it.each(["+358 40 123 4567", "+358401234567", "+358 9 123 4567"])("accepts %s", (p) => {
    expect(isValidPhone(p)).toBe(true);
  });
  it.each([null, "", "12345", "040 123 4567", "+358 40 123 456X", "+46 70 123 4567"])("rejects %s", (p) => {
    expect(isValidPhone(p)).toBe(false);
  });
});

describe("contactProblems", () => {
  it("returns nothing for valid data", () => {
    expect(contactProblems({ email: "a@example.com", phone: "+358 40 123 4567" })).toEqual([]);
  });
  it("separates missing from malformed", () => {
    expect(contactProblems({ email: null, phone: "  " })).toEqual(["email_missing", "phone_missing"]);
    expect(contactProblems({ email: "a@", phone: "123" })).toEqual(["email_malformed", "phone_malformed"]);
  });
});
