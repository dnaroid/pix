# Checkout Service Fixture

A deliberately small TypeScript-like checkout service for e2e orchestration tests.

## Areas

- `src/cart.ts` calculates cart totals.
- `src/discounts.ts` applies coupon logic.
- `src/payments.ts` builds payment requests for a gateway.
- `src/audit.ts` records checkout audit events.
- `docs/checkout-plan.md` contains a proposed rollout plan.

The code contains a few intentional issues for review agents to find.
