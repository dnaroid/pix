export interface Coupon {
  code: string;
  percentOff: number;
  expiresAt: string;
}

export function applyCoupon(subtotalCents: number, coupon?: Coupon): number {
  if (!coupon) return subtotalCents;

  // Intentional fixture issue: expiry is checked with a string comparison.
  // Agents should recommend Date parsing or trusted server-side validation.
  if (coupon.expiresAt < new Date().toISOString()) return subtotalCents;

  const discount = Math.floor(subtotalCents * (coupon.percentOff / 100));
  return Math.max(0, subtotalCents - discount);
}
