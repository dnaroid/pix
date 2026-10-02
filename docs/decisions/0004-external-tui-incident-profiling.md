# 0004 — External TUI incident profiling

- Status: accepted
- Recorded: 2026-10-02
- Decided: 2026-10-02
- Owner / approval evidence: coding assistant's scoped diagnostic design during
  the TUI memory incident discussion; no root-cause conclusion or leak-fix claim
  is approved by this record.
- Governing spec: [External TUI memory/freeze profiler](../../specs/tui-external-memory-profiler.md)
- Replaces / replaced by: none

## Context

The user reports TUI growth to roughly 9 GiB while typing after an answer has
finished, and frequent TUI freezes, while Desktop never freezes. The previous
thinking-stream fixes are present in the installed Pix build. The specific
typing-time cause remains unconfirmed; avoid changing unrelated Desktop work.

## Observations and sources

- User-reported symptoms above are conversation evidence from this 2026-10-02
  investigation, not independently reproduced measurements; no durable runaway
  profile has yet been captured.
- [`MemoryWatchdog`](../../src/app/diagnostics/memory-watchdog.ts) runs on Pix's
  event loop. A blocked loop cannot execute its periodic/deferred diagnostics.
- The [thinking-memory contract](../../specs/tui-streaming-thinking-memory.md)
  covers distinct streaming paths, not every post-answer typing recurrence.
- [Profiler tests](../../tests/pix-memory-profiler.test.ts) establish bounded
  polling/capture ownership and cancellation; they do not reproduce the leak.

## Decision

Add an opt-in source-checkout macOS launcher that samples the owned Pix child's
RSS externally and takes bounded `sample`/`vmmap` captures on threshold or manual
request. Keep it separate from product rendering and configuration. Collect
evidence before proposing a cause-specific fix; do not equate disabling
autocomplete or a short typing smoke test with eliminating the leak.

## Alternatives

- Only use the internal watchdog: lower setup cost, but blind while the main
  event loop is blocked.
- Always-on external supervisor: unnecessary startup/OS-process overhead and
  privacy surface before a cause is established.
- Force heap snapshots near 9 GiB: can amplify memory pressure and itself block
  the TUI; stack/maps are a lower-risk first capture, not equivalent heap evidence.
- Change render/autocomplete heuristics speculatively: risks hiding the symptom
  without establishing causality. A narrow fix needs recurrence evidence.

## Consequences

Additional terminal command and macOS inspection permissions are required.
Reports may reveal private paths and must be protected/redacted. OS stack/maps
may still be insufficient to identify retained JS objects. Bounded capture/poll
limits prevent diagnostic backlogs but can miss later incidents.

## Revisit when

A runaway profile identifies the causal path; repeated profiles require a longer
bounded window or stronger heap attribution; or ordinary launcher signal/terminal
behavior proves disruptive. Remove or replace diagnostic-only tooling when a
verified narrow fix and appropriate regression cover the incident.
