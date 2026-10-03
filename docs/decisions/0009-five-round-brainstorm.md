# 0009 — Five-round brainstorm with reviewed synthesis

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: in the conversation, the user selected the deep
  five-round option and clarification only for material uncertainty, after being
  told that four models imply 20 participant launches rather than eight. The user
  also asked about the protocol; the parent committed to retaining the draft and
  final synthesis separately. No separate durable conversation artifact is cited.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: supersedes [0008](0008-configured-brainstorm-council.md);
  [0019](0019-desktop-persistent-council-sessions.md) partially supersedes fresh
  participants for new Desktop runs; the five-round lifecycle remains unchanged.

Extension: [0010 — Audit council modes](0010-audit-council-modes.md) adds an audit
scenario and contextual routing; the five-round lifecycle remains in force.
[0017](0017-brainstorm-v4-protocol-storage.md) bounds later-round history with
ledgers and adds quorum, local storage and v4 manifests.

## Context

The two-round council offered independent proposals and critique, but no dedicated
idea-building phase, reply to objections or participant check of parent synthesis.
The user requested a deeper process rather than the short council.

## Observations and sources

- Verified baseline: the previous protocol in 0008 had two rounds and parent-only
  synthesis. The exact roster and existing async-subagent lifecycle are retained.
- User choice is conversation evidence, not a measured quality improvement.
- Assumption: separated development, critique, revision and synthesis review may
  improve coverage and fidelity. No live quality/cost comparison supports a claim
  of an "ideal" or guaranteed-correct brainstorm.

## Decision

Use five bounded rounds: independent ideas, development/combinations, critical
evaluation, revised proposals, then review of a parent-written draft. Clarify
material uncertainty before paid work without mandatory brief approval. The parent
remains responsible for final decisions, explicit dissent and review dispositions.

Split execution into run → review → finalize. Persist v2 configuration and all
completed round answers; review uses that snapshot. Preserve the exact reviewed
draft and hash separately from final proposal and revision notes. A shared lock
serializes continuation actions and state is checked after acquiring it. Reject
incomplete/legacy runs instead of treating two rounds as five-round evidence.

## Alternatives

- Four rounds without synthesis review: offered, but the user chose deeper review.
- Always approve the brief: offered, but the user chose adaptive clarification.
- Unlimited debate until agreement: not selected; dissent and bounded spending
  remain requirements. The fifth round audits synthesis, not another ideation loop.
- Silent continuation of old manifests: would imply nonexistent review evidence;
  old documents are retained, but the new workflow requires a new run.

## Consequences

Five times the roster size in ordinary participant runs, plus configured retries
and parent work. Prompts carry complete prior discussion and remain size bounded.
More cost and latency are intentional; improved quality remains unproven.
Mechanical guards enforce stage completion, not the truth of emitted claims or
semantic compliance of briefs/revision notes. No implementation starts automatically.
Crashes may still require manual lock/artifact inspection; no automatic resume.

## Revisit when

Live results show repetitive rounds, loss of minority views, unaffordable context,
frequent size-limit failures, or a need for resumability. Benchmark before adding
automatic consensus rules, judges or further rounds.
