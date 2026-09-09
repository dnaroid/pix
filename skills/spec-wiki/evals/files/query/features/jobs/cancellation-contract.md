# Background job cancellation contract

## Behavior

- Cancellation requests are idempotent.
- A running job transitions to `cancelled` when cancellation is accepted.
- Jobs already in `completed`, `failed`, or `cancelled` remain in that terminal
  state when cancellation is requested again.
- Cancellation does not imply that already-committed external side effects are
  rolled back.

## Verification

Tests should cover repeated cancellation, running-to-cancelled transition, and
all terminal states.
