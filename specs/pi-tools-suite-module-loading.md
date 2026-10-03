---
kind: spec
status: active
---

# Fault-tolerant pi-tools-suite module loading

## Behavior

Enabled modules load sequentially in catalog order; disabled and incompatible
host-only modules are not imported. An import error (including invalid TypeScript),
missing factory or rejected factory skips that module and continues with the next.
The startup log identifies each skipped module and its error. A session-start
warning lists skipped modules; successfully loaded capabilities remain available.

Each factory receives a module-scoped API. Registrations and event-bus
subscriptions/emissions are staged until the factory succeeds. A rejected factory
does not leave tools, commands, providers or handlers registered. Its retained API
rejects later calls. Successful modules retain normal dynamic registration and
unsubscribe behavior after initialization.

## Constraints and failure cases

- This is error containment, not a sandbox, protocol validation or a guarantee
  that an unfinished feature is correct. It does not undo arbitrary factory
  side effects, stop hung imports/factories, prevent process termination or catch
  errors in later handlers. Factories must own resource cleanup and defer lasting
  side effects to lifecycle handlers.
- The public SDK cannot roll back a partially applied registration batch. If the
  SDK rejects a commit, the suite factory fails and SDK extension isolation skips
  the whole suite rather than retaining a partially registered suite. Other
  extensions and the host remain available. Configuration and suite-entrypoint
  errors likewise remain whole-extension failures.
- Registration staging covers SDK `on`, `register*`, `unregister*` and event-bus
  `on`/`emit`. Reads during initialization observe already committed registrations,
  not the pending batch. New SDK registration APIs need a compatibility review.
- A skipped module may remove capabilities required by another module; loading
  protection does not repair those dependencies. Retry requires reload/restart
  after fixing the cause, not an automatic retry loop.

Decision: [0012 — Isolate suite module loading](../docs/decisions/0012-isolate-suite-module-loading.md).

## Implementation

- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/module-loader.ts`

## Tests

- `external/pi-tools-suite/test/module-loader.test.ts`

## Verification

Run suite typecheck and `bun test test/module-loader.test.ts`. Deterministic tests
exercise a real parsing failure, rejected asynchronous factories, discarded
registrations and bus events, stale APIs, unsubscribe, dynamic registration and
SDK whole-extension isolation. These tests do not certify unfinished brainstorm
behavior or replace real UI startup verification.
