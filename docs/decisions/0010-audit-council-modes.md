# 0010 — Audit scenario and transparent parent routing

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: the user accepted adding an audit scenario to the
  existing five-round engine and asked whether mode routing would be automatic.
  The parent chose contextual routing with a visible choice, explicit override
  and clarification for mixed goals. This routing detail is a parent design
  choice, not a separately approved user specification. Conversation-only
  evidence; no separate durable conversation artifact is cited.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: none; extends [0009](0009-five-round-brainstorm.md)
  without replacing the five-round lifecycle or brainstorm scenario.

## Context

The user wants to audit an existing game design as well as generate concepts.
Idea generation and development prompts are not an audit protocol: they risk
redesigning the work instead of substantiating defects against author intent.

## Observations and sources

- Existing five-round execution, locks, original-roster review and separate
  draft/final artifacts are documented in 0009 and retained.
- The new [audit regressions](../../external/pi-tools-suite/test/brainstorm/audit.test.ts)
  verify mode-specific prompts, artifacts and continuation compatibility.
- Assumption: contextual parent routing is more useful than keyword matching
  for mixed-language and context-dependent requests. No live routing-quality or
  audit-quality measurement has been made; prompt tests are not such evidence.

## Decision

Keep one engine with resolved `brainstorm | audit` modes. Audit rounds are
findings, cross-check/coverage, critique of findings, priorities/minimal fixes,
and review of the parent report. Require cited evidence, severity separate from
confidence, explicit coverage limits and valid no-findings outcomes. Treat fun
and balance as test hypotheses without playtest evidence; preserve author intent.

Use `/brainstorm [--mode auto|brainstorm|audit] <topic>`. Default auto is a parent
instruction, not a paid classifier or deterministic keyword heuristic. Announce
the selection; explicit flags override inference; clarify mixed/unclear goals
before spending. Do not auto-launch councils for ordinary audit requests.

Persist the resolved mode in v3 before paid rounds. Continuation cannot select
a new mode. Original v2 manifests continue as brainstorm and upgrade on mutation;
v1 stays unsupported. Keep existing artifact names, including proposal.md for an
audit report, to avoid separate persistence/locking mechanisms.

## Alternatives

- Separate audit engine/command: duplicates lifecycle and persistence ownership;
  a mode preserves the established entrypoint while separating the prompts.
- Keyword classifier or another model call: respectively loses conversational
  intent or adds unnecessary latency/cost before the parent prepares the brief.
- Silent hybrid audit/redesign or two automatic councils: ambiguous deliverable
  and spending; ask the user to prioritize instead.
- Reject all v2 continuations: unnecessary; the original format unambiguously
  means brainstorm and has the same five-round lifecycle.

## Consequences

No extra rounds or roster changes. Two mode-specific prompt/report contracts need
maintenance. Mode validation is deterministic, but routing, evidence quality and
source availability checks rely on model behavior. Target files are not frozen;
the brief must identify versions and coverage limits. Existing locks are not a
sandbox against external editing of manifests or target documents.

## Revisit when

Live evaluations show misrouting, unnecessary clarification, invented findings,
lost source lineage or recurring source-version drift; consider measured routing
evals and source snapshots before adding more judges or automatic extra rounds.
