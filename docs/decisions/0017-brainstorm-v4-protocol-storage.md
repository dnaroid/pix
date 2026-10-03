# 0017 — Brainstorm v4: local protocol storage, quorum and ledger history

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: in the conversation (2026-10-03 ~11:42) the parent
  proposed twelve prioritized changes (P1–P3) after a real council run; the user
  replied «да, сделай все правки» and added that the roster should come from
  `frontierModels` (a weak model had already been removed there) and that GLM
  must use `max` thinking. No separate durable conversation artifact is cited.
- Governing spec: [brainstorm](../../specs/brainstorm.md)
- Replaces / replaced by: extends [0009](0009-five-round-brainstorm.md) (five-round
  lifecycle unchanged) and supersedes the explicit default roster from
  [0008](0008-configured-brainstorm-council.md); [0019](0019-desktop-persistent-council-sessions.md)
  partially supersedes fresh-worker/history execution for new Desktop runs only.

## Context

A real council run produced a ~155 KB discussion plus a ~163 KB manifest that
duplicated every response, wrote the protocol into `docs/brainstorms/` (and thus
into the knowledge base), used private 0600 file modes, failed the whole run
when a single participant failed, and re-sent all earlier rounds in full to every
participant in every later round. Participants reused bare IDs (`H1`) that
collided across slots, re-verified facts already checked by peers, reopened
fixed decisions and occasionally emitted stray foreign-script tokens.

## Observations and sources

- Reported observation (parent, from the run): sizes above and a weak
  contribution from the Gemini Flash participant. No benchmark measured quality.
- Estimate, not measured: ledger-only older history reduces prompt size 2–3×.
- Verified by deterministic tests: quorum gaps, ledger parsing/matrix, file-backed
  responses with SHA-256 checks, outputDir confinement, publish, v2/v3 migration.

## Decision

- Roster: without explicit `brainstorm.models` (or with `null`) use enabled
  `frontierModels` in order (max 6). An explicit list still replaces it exactly.
- Thinking: `brainstorm.thinkingOverrides` per model (exact ref or bare id);
  default `zai/glm-5.3 = max`.
- Storage: `brainstorm.outputDir`, default `.pi/brainstorms/` (outside the
  knowledge base). `finalize` with `publish=true` copies only the final proposal
  to `docs/brainstorms/<run>.md`. Documents use 0644; only the lock is 0600.
  `docs/brainstorms/` remains an accepted legacy run root for continuation.
- Manifest `pi-brainstorm-v4`: response texts in `rounds/<id>.md`; the manifest
  keeps id/model/file/sha256/chars (and optional script warnings). v3 and
  original mode-less v2 runs are migrated to v4 on successful continuation.
- Quorum: `brainstorm.quorum`, default `max(2, roster − 1)`. Failed/timed-out
  participants are recorded as coverage gaps in manifest and discussion; below
  quorum the round fails. Legacy runs keep the all-participants requirement.
- History: participants end rounds 1–4 with a `## Ledger` table; later rounds get
  the previous round in full and older rounds as ledgers (own earlier answers in
  full in round 4). `discussion.md` opens with a position matrix built from them.
- Prompt rules: slot-prefixed IDs (`P2-H3`), a "Fixed decisions" brief section
  reopened only via `REOPEN:` with new evidence, no repeated discovery after
  round 1, respond in the brief's language. Foreign-script tokens produce
  advisory warnings, never rejection.

## Alternatives

- Only P1 (prompts/storage) first, format change later: offered; the user chose
  all changes at once.
- Keep an explicit default roster / replace Gemini: rejected by the user in favour
  of deriving from `frontierModels`.
- Strict all-participant rounds: kept only for legacy runs; one provider failure
  wasted a whole paid run.

## Consequences

Smaller manifests and prompts, protocols out of the knowledge base by default,
resilience to a single participant failure at the cost of reduced coverage that
is visible as gaps. Ledger quality depends on model compliance; a missing ledger
degrades to a bounded excerpt. Roster changes to `frontierModels` now affect new
councils. Residual risk (unchanged): finalization replaces `proposal.md` before
optional publication and final manifest persistence; a later failure marks the
run incomplete without a retry path. No paid council has validated v4 yet.

## Revisit when

Live runs show unusable ledgers or matrices, frequent quorum gaps, the frontier
roster producing unsuitable councils, or a need for resumable finalization.
