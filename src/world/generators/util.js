/** Small helpers shared by level generators. Nothing here knows about a particular generator. */

/** Small, fast, seedable PRNG (mulberry32). Returns a function yielding floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [lo, hi] from a `rng()` float. */
export const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Round and clamp into [lo, hi]; non-numbers count as 0. */
export const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

/** "1 guard" / "3 guards" for level descriptions. */
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;