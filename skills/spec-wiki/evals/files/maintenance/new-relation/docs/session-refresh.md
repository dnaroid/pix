# Session refresh contract

## Type

As-is

## Lifecycle

Active

## Behavior

Interactive and background session refresh retry a transient token-acquisition
failure exactly once. A second token-acquisition failure propagates to the
caller. Successful acquisition is not retried.

## Related files

- `src/session.ts`

## Verification

- Interactive refresh covers success, retry-success, and second-failure paths.
- Every additional refresh entrypoint must preserve the same retry contract.
