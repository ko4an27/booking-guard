/**
 * A small seeded random number generator.
 * The same seed always produces the same sequence, so `npm run seed` builds identical data
 * every time and the expected error counts in tests/expected.json stay valid.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** One random element of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** A shuffled copy; the input array is not changed. */
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  // mulberry32: a tiny, well-known PRNG. It keeps a 32-bit state and scrambles it with
  // multiplications and bit shifts on every call. Good enough for test data, not for security.
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error("pick() called with an empty array");
    return items[int(0, items.length - 1)] as T;
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    // Fisher–Yates: walk backwards and swap each element with a random earlier (or same) one.
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i);
      [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
  };

  return { next, int, pick, shuffle };
}
