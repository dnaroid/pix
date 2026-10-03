# 0019 — Desktop councils own persistent participant sessions

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: in this implementation conversation the user accepted
  one full session per participant plus a compact storm panel, then selected
  «Сначала Desktop», explicitly leaving terminal execution unchanged. No separate
  durable conversation artifact is cited. The parent selected ACP ownership to
  satisfy the single-writer constraint.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: partially supersedes the fresh-worker execution and
  replayed-history choices in [0009](0009-five-round-brainstorm.md) and
  [0017](0017-brainstorm-v4-protocol-storage.md) for new Desktop runs only.

## Context

Fresh workers each round duplicate setup and replay context. The requested UI
needs genuine navigable participant conversations, not round-specific subagent
logs or synthetic conversations. Five rounds remain fixed; freeform orchestration
and terminal support are not part of this slice.

## Observations and sources

- Repository inspection: the suite's old adapter launches nested subagents per
  round. The SDK extension context does not expose creation of separate native
  Pix sessions; ACP owns their lifecycle and catalog.
- A second SDK writer attached to the same session file could corrupt ownership
  and permit user/orchestrator interleaving. This is a design risk, not a reported
  production incident.
- Suite deterministic tests cover execution-mode persistence, delta prompts,
  exact attribution, continuation rejection and release notification.
- Cost/latency improvements are expectations, not measured savings. No paid
  council was requested as part of implementation verification.

## Decision

- ACP creates and owns one real native session per roster slot, reused through
  round 5, including the parent synthesis pause. Opening it attaches to that
  owner, never opens a second writer.
- An authenticated loopback capability scoped to the orchestrator connects the
  headless suite to ACP. It is not a public tool parameter or stored credential.
  Participants do not inherit that capability.
- Exact models and read-only research tools remain mandatory. Active council
  ownership blocks direct user mutations; titles are presentation only.
- Explicit run/parent/slot/session metadata drives the compact panel and native
  navigation. Names use `[BS:<id>]` for recognition, never for association.
- The manifest records `execution: desktop-sessions`. Continuation must not
  silently replace missing sessions with fresh workers. Existing/TUI runs retain
  their old execution and bounded history contract.
- Persistent participants receive the brief in round 1 and newly completed peer
  answers thereafter, with the draft in round 5. No current-round sibling answers
  are injected. Ledgers and file-backed response hashes remain protocol artifacts.

## Alternatives

- Independent SDK sessions outside ACP: rejected because Desktop opening and
  ownership would require a second runtime or another attach mechanism.
- A fresh native session per round: does not meet the accepted continuity goal.
- Desktop and TUI together: offered; user selected Desktop first.
- Parse the name prefix: rejected; renaming must not change linkage.
- Freeform rounds now: deferred to keep the accepted five-round protocol stable.

## Consequences

Participant history is inspectable and reused, with additional ACP lifecycle,
capability and cancellation responsibilities. Context still grows over rounds;
provider caching/compaction determines actual cost. Crash recovery of active
councils is not introduced. A lost host cannot continue a run by replacement.
Terminal runs continue to pay fresh-worker setup until a separate migration.

## Revisit when

Real runs demonstrate context growth, latency or ownership problems; restart
recovery becomes necessary; terminal support is requested; or freeform orchestration
has explicit acceptance criteria.
