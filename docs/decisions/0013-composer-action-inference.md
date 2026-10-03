# 0013 — Conservative composer action inference

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user approved conservative command/subagent action labels and requested all concurrent actions on one line in this conversation (no durable transcript link).
- Governing spec: [Desktop activity row timing](../../specs/desktop-activity-row-timing.md)
- Replaces / replaced by: none

## Context

Generic command/agent labels conceal useful live intent. Rendering raw command or
task text would expose sensitive data and require repeated payload inspection.
The user explicitly rejected hiding concurrent calls behind a count.

## Observations and sources

- [Transcript reducer](../../desktop/src/lib/transcript-reducer.ts) owns ingestion
  and incremental tool metadata updates, including cached skill names.
- [Composer derivation](../../desktop/src/lib/composer-activity.ts) filters live
  entries within the current turn; it is independent of collapsed chat labels.
- [Classifier tests](../../desktop/src/lib/tool-activity.test.ts) verify safe
  fallbacks and cache refresh. Package-script names are intent conventions, not
  proof of what a custom script does; this is an explicit assumption.

## Decision

Cache only fixed action labels at ingestion. Recognize exact subagents actions
and bounded simple command prefixes; reject shell programs and ambiguous syntax.
Never expose arguments or infer from occurrences of words such as `test`.
Render every active entry in call order, including repeated labels, as one
ellipsis-truncated string with full safe hover text. Keep current hold/lifecycle
behavior. Response-writing detection via streaming events is outside this slice.

## Alternatives

- Keep all commands generic: safe, but less informative for simple known intent.
- Parse arbitrary shell programs or show arguments: broader coverage at the cost
  of complexity, misleading classifications and disclosure risk.
- Count/deduplicate parallel calls: hides actions contrary to the user's request.

## Consequences

Simple calls gain useful labels; chained, redirected or quoted commands remain
generic intentionally. Render paths inspect no payloads. Long parallel lists
truncate visually, with every action still in the text/hover label. Intent labels
must not be interpreted as execution or success guarantees.

## Revisit when

Verified common invocations need additional safe prefixes, script naming proves
misleading, or explicit streaming events are used to identify response writing.
