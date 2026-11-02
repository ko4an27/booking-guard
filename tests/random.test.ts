import { describe, expect, it } from "vitest";
import { createRng } from "../src/random.ts";

describe("createRng", () => {
  it("gives the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect(Array.from({ length: 5 }, () => a.next())).toEqual(Array.from({ length: 5 }, () => b.next()));
  });

  it("gives a different sequence for a different seed", () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it("int() stays inside [min, max] and reaches both ends", () => {
    const rng = createRng(7);
    const values = Array.from({ length: 1000 }, () => rng.int(3, 6));
    expect(Math.min(...values)).toBe(3);
    expect(Math.max(...values)).toBe(6);
  });

  it("pick() returns an element and rejects an empty array", () => {
    const rng = createRng(7);
    expect(["a", "b", "c"]).toContain(rng.pick(["a", "b", "c"]));
    expect(() => rng.pick([])).toThrow();
  });

  it("shuffle() returns a permutation and does not change the input", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = createRng(7).shuffle(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...out].sort((x, y) => x - y)).toEqual(input);
  });
});
