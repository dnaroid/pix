# Background job cancellation contract

## Type

As-is

## Lifecycle

Active

## Behavior

Cancelling a running job is idempotent. Running jobs become cancelled; already
terminal jobs remain terminal.

## Related files

- `src/job.ts`
