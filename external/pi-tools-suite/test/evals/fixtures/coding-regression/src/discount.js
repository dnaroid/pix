// @ts-nocheck
export function discountedPrice(cents, percent) {
  if (!Number.isFinite(cents) || !Number.isFinite(percent)) throw new TypeError("finite numbers required");
  if (percent < 0 || percent > 100) throw new RangeError("percent must be 0..100");
  return Math.round(cents * (1 - percent / 100));
}
