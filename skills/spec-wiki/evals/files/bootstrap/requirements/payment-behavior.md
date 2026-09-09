# Payment capture requirements

## Behavior

- A capture request with the same idempotency key must not charge twice.
- A successful capture returns the existing capture result when the same key is
  replayed.
- A different amount with a reused idempotency key is rejected.

## Related files

- `src/payments.ts`
- `tests/payments.test.ts`

## Verification

Cover first capture, exact replay, and conflicting replay.
