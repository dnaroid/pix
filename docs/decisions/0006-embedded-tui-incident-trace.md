# 0006 — Embedded opt-in TUI incident trace

- Status: accepted
- Recorded: 2026-10-02
- Decided: 2026-10-02
- Owner / approval evidence: user asked to find the leak and suggested temporarily embedding a watchdog; parent chose opt-in rather than global default changes.
- Governing spec: [Opt-in TUI incident trace](../../specs/tui-embedded-memory-trace.md)
- Replaces / replaced by: none; complements [0004](0004-external-tui-incident-profiling.md), whose standalone contract is unchanged.

## Context

The user reports freezes and roughly 9 GiB RSS after completed answers, while
typing Russian drafts; Desktop is reportedly unaffected. The prior streaming
fix does not establish the cause of this recurrence. A main-loop watchdog cannot
sample during a blocked loop; the standalone profiler adds launch friction.

## Observations and sources

Verified source facts: the watchdog uses the TUI event loop and can take a
synchronous heap snapshot; the external collector has bounded macOS polling,
capture and cancellation. Focused native/input and JS draft-lifecycle source
reviews found no confirmed causal retention; that is not runtime leak exclusion.
Earlier UI attempts did not produce a proper typing soak. The 9 GiB symptom and
Desktop comparison are user-reported, not newly reproduced measurements. No JS
versus native memory assumption is treated as a finding.

## Decision

Add macOS-only `PIX_MEMORY_TRACE=1` to ordinary TUI startup. Reuse the external
collector in an independent child, correlate with bounded primitive heartbeats,
save sampled V8 allocation profiles, and skip full watchdog heap snapshots in
this mode. Explicitly package the two shared collectors. Do not change global
config, autocomplete, Desktop or product behavior on an unconfirmed hypothesis.

## Alternatives

- Main-loop-only telemetry cannot observe a blocked loop.
- Always-on profiling/child imposes routine overhead without evidence for it.
- Standalone launcher remains useful but does not integrate normal TUI startup.
- Speculative native/renderer rewrite lacks causal evidence.

## Consequences

Independent evidence survives stalls; JS metrics/sampled call sites help separate
retained JS growth from external RSS. Sampling can be stale/incomplete and does
not identify native ownership by itself. Opt-in overhead and private local files
remain; bounds are per run, not global. This is instrumentation, not a leak fix.

## Revisit when

Captured growth identifies a reproducible retention path, profiling measurably
changes the incident, bounds prove insufficient, or resolution permits removing
temporary tooling.
