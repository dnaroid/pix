import type { CartItem } from "./cart.js";
import { calculateCartTotals } from "./cart.js";
import { applyCoupon, type Coupon } from "./discounts.js";

export interface CheckoutInput {
  userId: string;
  items: CartItem[];
  coupon?: Coupon;
  cardToken: string;
}

export interface PaymentRequest {
  userId: string;
  amountCents: number;
  cardToken: string;
  idempotencyKey: string;
}

export function buildPaymentRequest(input: CheckoutInput): PaymentRequest {
  const totals = calculateCartTotals(input.items);
  const amountCents = applyCoupon(totals.subtotalCents, input.coupon);

  // Intentional fixture issues for code-review agents:
  // - no validation for empty carts or non-positive quantities/prices;
  // - cardToken is passed through without redaction boundaries;
  // - idempotencyKey is random, so retries can double-charge.
  return {
    userId: input.userId,
    amountCents,
    cardToken: input.cardToken,
    idempotencyKey: `${input.userId}-${Date.now()}-${Math.random()}`,
  };
}
