/**
 * Decimal amounts as typed by people <-> integer token units, without
 * floating point (a 24-decimal NEAR amount doesn't fit in a JS number).
 */

export const NEAR_DECIMALS = 24;

/** "1.5" with 24 decimals -> 1500000000000000000000000n. Null if it isn't a positive amount with at most `decimals` places. */
export function toUnits(text, decimals) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? "").trim());
  if (!match) return null;
  const [, whole, fraction = ""] = match;
  if (fraction.length > decimals) return null;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  return units > 0n ? units : null;
}

/** 1500000000000000000000000n with 24 decimals -> "1.5", rounded down to `maxFraction` places. */
export function fromUnits(units, decimals, maxFraction = 4) {
  const value = BigInt(units);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  let fraction = (value % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (!fraction && value > 0n && whole === 0n) return `<0.${"0".repeat(maxFraction - 1)}1`;
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
