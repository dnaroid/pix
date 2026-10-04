# 0032 — Per-conversation Desktop reading positions

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user explicitly selected “Последнее место чтения” in the scroll-bug discussion; conversation-only approval, no durable external artifact.
- Governing spec: [Desktop transcript scrolling](../../specs/desktop-transcript-scrolling.md)
- Replaces / replaced by: none

## Context

The user reported that switching restored conversation tabs returned to an old
launch-time position and requested each tab retain its last reading position.

## Observations and sources

- Verified in `desktop/src/app/transcript-scroll.svelte.ts`: conversation activation previously always enabled follow-latest, while auxiliary-tab hiding retained one offset.
- User-reported launch-time reset is not yet independently reproduced.
- Deterministic regression coverage: `desktop/src/app/transcript-scroll.test.ts`.

## Decision

Keep reading offsets and follow mode per conversation in the window's scroll
controller. Capture outgoing state before DOM replacement. Pending/hidden
geometry cannot replace saved state. First visits follow latest; subsequent
visits restore reading position or the current live edge according to that
conversation's saved mode. Keep explicit latest actions and entry navigation.
Do not add disk persistence for reading positions.

## Alternatives

- Always return to latest: rejected by the user's explicit reading-position choice.
- Persist positions across restart: unnecessary for the requested tab-switch behavior and adds restoration/pagination coordination outside this fix.

## Consequences

Readers can alternate conversations without losing their place. Saved numeric
offsets can be clamped if content shrinks; this does not promise entry anchoring
across arbitrary transcript edits. The map is released with the controller.

## Revisit when

Users need restart persistence, or transcript changes while hidden require
entry-based rather than numeric-offset restoration.
