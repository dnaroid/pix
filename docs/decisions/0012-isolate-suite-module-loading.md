# 0012 — Isolate suite module loading

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user explicitly requested protection before transferring all `issue` changes, noting brainstorm work is unfinished (task conversation).
- Governing spec: [Suite module loading](../../specs/pi-tools-suite-module-loading.md)
- Replaces / replaced by: none

## Context

A parsing error in brainstorm instructions on `issue` prevents loading the
bundled suite. The user wants all unfinished branch work preserved, but protection
must be added and tested before transfer. This decision does not approve the
unfinished brainstorm protocol as a release-ready replacement.

## Observations and sources

Verified: the suite entrypoint rethrows every module import/factory error.
Installed Pi SDK 1.0.0 already records whole-extension loading errors and continues
loading other extensions. Its public registration API lacks complete rollback.
Factories can register capabilities before rejecting, so catch-and-continue alone
could retain a half-initialized module. See [the implementation and tests](../../specs/pi-tools-suite-module-loading.md).

Reported: user observed a broken harness during unfinished brainstorm work.
Assumption/limit: ordinary load errors are containable; arbitrary resource side
effects, hangs and later execution errors are not isolated by this mechanism.

## Decision

Stage module registrations and bus subscriptions/emissions. Commit after successful
factory completion, discard on import/factory failure, warn and continue. A commit
failure remains a whole-suite SDK failure because continuing cannot safely undo
already applied registrations. Keep all `issue` work as WIP after protection passes;
fix the known syntax error without claiming the protocol has been completed.

## Alternatives

- Catch imports only: protects parsing failures but not rejected factories.
- Catch everything without staging: could expose incomplete registrations.
- Implement a separate extension runtime per module: larger SDK-coupled redesign,
  unnecessary for the immediate parsing-error containment requirement.
- Finish brainstorm before transfer: contrary to the user's requested order/scope.

## Consequences

An ordinary broken module no longer removes the rest of the suite. Skipped modules
are visible, not silently ignored. Registrations are briefly buffered; factories
must not rely on reading their uncommitted registrations. This is not release
approval for unfinished work, and non-registration side effects still need ownership.

## Revisit when

SDK registration APIs change, a module requires self-introspection during factory
initialization, or a failure demonstrates resource leaks/hangs requiring module
cleanup contracts or stronger runtime isolation.
