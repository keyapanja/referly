/**
 * All monetary amounts are integers in minor units (cents, paise).
 * Rates are expressed in basis points (1% = 100 bps) so percentage math is integer-only.
 */

export type MinorUnits = number;
export type BasisPoints = number;

export function assertMinorUnits(value: unknown, label = "amount"): asserts value is MinorUnits {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer in minor units, got ${String(value)}`);
  }
}

export function assertNonNegative(value: number, label = "amount"): void {
  assertMinorUnits(value, label);
  if (value < 0) throw new RangeError(`${label} must be >= 0, got ${value}`);
}

/** Round half to even (banker's rounding) of numerator / denominator, integer-only. */
export function divideHalfEven(numerator: number, denominator: number): number {
  if (denominator === 0) throw new RangeError("division by zero");
  const negative = numerator < 0 !== denominator < 0;
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  let result = q;
  const twice = r * 2;
  if (twice > d) result = q + 1;
  else if (twice === d) result = q % 2 === 0 ? q : q + 1;
  return negative ? -result : result;
}

/** amount * bps / 10_000 with half-even rounding. */
export function applyBasisPoints(amount: MinorUnits, bps: BasisPoints): MinorUnits {
  assertMinorUnits(amount, "amount");
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError(`rate must be a non-negative integer in basis points, got ${bps}`);
  return divideHalfEven(amount * bps, 10_000);
}

/** Proportional share: amount * part / whole, half-even. */
export function proportion(amount: MinorUnits, part: number, whole: number): MinorUnits {
  assertMinorUnits(amount, "amount");
  if (whole <= 0) throw new RangeError("whole must be > 0");
  if (part < 0 || part > whole) throw new RangeError("part must be within [0, whole]");
  return divideHalfEven(amount * part, whole);
}

export function percentToBps(percent: number): BasisPoints {
  const bps = Math.round(percent * 100);
  if (!Number.isFinite(bps) || bps < 0) throw new RangeError(`invalid percent ${percent}`);
  return bps;
}

export function bpsToPercent(bps: BasisPoints): number {
  return bps / 100;
}
