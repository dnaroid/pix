---
kind: spec
status: active
---

# Payment retry contract

## Behavior

Each gateway request receives a fresh random idempotency key. Repeated requests
for one checkout can therefore double-charge; the current implementation does
not guarantee retry deduplication.

## Implementation

- `src/payments.ts`

## Tests

- `test/run-tests.js`
