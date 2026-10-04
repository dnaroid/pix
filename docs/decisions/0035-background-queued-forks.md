# 0035 — Background queued forks

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested a new delayed message type; explicitly
  revised automatic tab switching to keeping the current tab selected.
- Governing spec: [Desktop queued send to fork](../../specs/desktop-send-to-fork.md)
- Replaces / replaced by: none

## Context and evidence

The existing message-context fork branches before a chosen user message and
switches the active conversation. Neither behavior matches sending a new prompt
against the current branch at a steering boundary. Installed Pi SDK 1.0.2 emits
`turn_end` after the assistant and tool-result messages have been persisted;
reading the current leaf later in ACP can race subsequent source turns.

## Decision and scope

Represent fork sends separately from SDK steering and deferred source messages.
Capture the exact native branch boundary in the Pi process, materialize an
independent child in ACP, and place the payload in that child's auto queue.
Desktop primes history, exposes a background tab and uses ordinary prompt
execution. It never changes active session, composer ownership or focus.

## Alternatives

- Fork before the latest user entry: loses the current response and tool results.
- Clone when an asynchronous ACP callback eventually runs: races later turns.
- Insert a synthetic steering prompt or pause/cancel the source: changes source
  behavior and may stop work the user wants to continue.
- Wait for full agent settlement: unnecessarily delays a steering-like request.
- Run prompts via a separate backend-only path: duplicates Desktop prompt and
  activity lifecycle instead of reusing the child auto queue.

## Consequences and revisit triggers

The private ACP protocol and RPC boundary annotation must evolve together.
Pending requests require cancellation, persistence and teardown protection;
child startup failures must keep its queued input recoverable. Revisit when SDK
boundary ordering changes or a public atomic snapshot API replaces the local
bridge. This choice does not implement a TUI send-to-fork action or detached
execution when Desktop is not connected.
