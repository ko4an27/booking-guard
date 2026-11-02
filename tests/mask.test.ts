import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone } from "../src/mask.ts";

describe("maskEmail", () => {
  it("keeps the first letter and the domain", () => {
    expect(maskEmail("anna.virtanen@example.com")).toBe("a***@example.com");
  });
  it("hides everything but the first letter when there is no @", () => {
    expect(maskEmail("anna.virtanen.example.com")).toBe("a***");
  });
  it("handles missing and empty values", () => {
    expect(maskEmail(null)).toBe("(missing)");
    expect(maskEmail("")).toBe("(empty)");
  });
});

describe("maskPhone", () => {
  it("keeps the country code and the last two digits", () => {
    expect(maskPhone("+358 40 123 4512")).toBe("+358 *** ** 12");
    expect(maskPhone("+358401234512")).toBe("+358 *** ** 12");
  });
  it("masks numbers without a country code", () => {
    expect(maskPhone("0401234512")).toBe("*** ** 12");
  });
  it("hides very short values completely", () => {
    expect(maskPhone("1234")).toBe("***");
  });
  it("handles missing and empty values", () => {
    expect(maskPhone(null)).toBe("(missing)");
    expect(maskPhone(" ")).toBe("(empty)");
  });
});
