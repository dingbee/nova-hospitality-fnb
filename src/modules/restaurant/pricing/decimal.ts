/**
 * Financial arithmetic helpers.
 *
 * Money is never added or multiplied as raw IEEE-754 floats here: every value
 * is scaled to an integer minor unit, combined, then scaled back. `0.1 + 0.2`
 * returns `0.3`, not `0.30000000000000004`, and a bill made of many small
 * lines cannot drift a cent away from the receipt the guest holds.
 */

const SCALE = 1e6;

const toInt = (n: number) => Math.round(Number(n || 0) * SCALE);
const fromInt = (i: number) => i / SCALE;

/** Exact addition of any number of money values. */
export function add(...values: number[]): number {
  return fromInt(values.reduce((s, v) => s + toInt(v), 0));
}

export function sub(a: number, b: number): number {
  return fromInt(toInt(a) - toInt(b));
}

/** Exact multiplication of a money value by a quantity or factor. */
export function mul(amount: number, factor: number): number {
  return fromInt(Math.round(toInt(amount) * Number(factor || 0)));
}

export function div(amount: number, divisor: number): number {
  if (!divisor) throw new Error("Division by zero in a financial calculation.");
  return fromInt(Math.round(toInt(amount) / divisor));
}

/** A percentage of an amount, e.g. `percent(100, 18) === 18`. */
export function percent(amount: number, rate: number): number {
  return fromInt(Math.round((toInt(amount) * Number(rate || 0)) / 100));
}

/** Half-up rounding to a fixed number of decimals, free of float drift. */
export function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  const scaled = toInt(value) / SCALE;
  return Math.round((scaled + Number.EPSILON) * factor) / factor;
}

/** Money rounding at the working precision used inside the engine. */
export const work = (n: number) => roundTo(n, 4);
/** Money rounding at the presentation precision used on bills. */
export const money = (n: number, decimals = 2) => roundTo(n, decimals);

export type RoundingMode = "none" | "nearest" | "up" | "down";

/**
 * Applies a configured rounding policy: a decimal precision plus an optional
 * cash increment (e.g. TZS to the nearest 100).
 */
export function applyRounding(
  value: number,
  policy: { mode: RoundingMode; increment: number; decimals: number },
): number {
  const decimals = Number.isFinite(policy.decimals) ? policy.decimals : 2;
  const base = roundTo(value, decimals);
  const inc = Number(policy.increment || 0);
  if (policy.mode === "none" || inc <= 0) return base;
  const steps = base / inc;
  const rounded =
    policy.mode === "up"
      ? Math.ceil(steps - Number.EPSILON)
      : policy.mode === "down"
        ? Math.floor(steps + Number.EPSILON)
        : Math.round(steps);
  return roundTo(rounded * inc, decimals);
}