# 0034 — Bounded, opt-in Heads up observer

Evaluation follow-up (2026-10-04): the user requested an evaluator in this same
conversation. [The synthetic eval guide](../heads-up-eval.md) documents a
single-inference, opt-in harness using the production prompt/context/parser;
no full-agent runner or additional model judge is required. Scenario labels,
source checks and transparent lexical anchors are mechanically checkable, but
semantics still need manual review, including automated passes. This extends
verification of the experiment, not its default enablement or rollout scope.

- Status: accepted for an opt-in experiment, not general rollout
- Recorded: 2026-10-04 (retrospective documentation of the same-day discussion)
- Decided: 2026-10-04
- Owner / approval evidence: the user approved implementation after the revised
  Heads up design in this conversation, then requested independent review of
  Luna's implementation. This approval is conversation-only; no separate
  durable approval record is available.
- Governing spec: [Heads up observer](../../specs/heads-up-observer.md)
- Replaces / replaced by: none

## Context

The user asked to investigate Claude Code's You Should Know and then try a
similar feature in Pix. The revised design narrowed the experiment to concrete,
consequential, probably unnoticed tradeoffs or contradictions in the current
task. Generic educational tips and a second autonomous code reviewer are outside
scope. The main agent and the user's composer must remain under their existing
owners, without observer-driven continuations or automatic edits.

## Observations and sources

The [inference adapter](../../src/bundled-extensions/heads-up/inference.ts) uses
the configured model registry with an empty tool list and no retries. The
[controller tests](../../tests/heads-up-controller.test.ts) exercise cadence,
bounded input, cancellation, late-result rejection and original-session usage.
The [extension tests](../../tests/heads-up-extension.test.ts) cover nonblocking
hooks, context edits, restricted runtimes and draft preservation. Desktop and ACP
coverage is linked from the governing spec.

Assumptions remain explicit: rare, evidence-backed notices may help people
supervise long coding tasks, but neither usefulness nor cost effectiveness has
been measured on real sessions. Luna is an initial configured candidate, not a
demonstrated best model. No model-family diversity benefit has been established.

## Decision

Use one bounded, tool-less model request through the existing registry rather
than a new session-fork API or the full async-subagent runner. Refresh a bounded
observation from the current session projection, separate user requirements from
assistant claims, and require real source IDs. Default to no notice.

Keep the feature off by default, with explicit enablement and a separately chosen
model. Do not silently fall back to the parent or switch providers. Rate and
input limits apply to manual checks too. Account finalized billable usage in the
originating session even when its finding becomes stale.

Present one expiring notice with local evidence expansion and session/runtime-local
feedback. Returning a note to the main conversation only fills a safe, empty
draft; the user chooses whether to send it. No learning pages, auto-fixes,
cross-session knowledge profile or feature telemetry are introduced.

## Alternatives

A full async subagent adds execution capabilities and lifecycle machinery that
this passive observer does not need. A new general fork primitive would expand
the implementation before this feature's value is established. Repeated full
transcript requests weaken cost bounds; using only the parent's summary risks
omitting the overlooked fact itself.

Mandatory opposite-provider selection and multi-stage explanation requests were
deferred as separate, unproven quality/cost hypotheses. Automatic feedback into
the parent would change the feature from a user-facing observer into an agent
control mechanism.

## Consequences

The design limits interference and bounds request volume, but cannot independently
validate code or guarantee that a notice is correct. Truncated context can hide
relevant evidence. Credential filtering is best-effort; enabling the feature
sends selected conversation excerpts to its configured provider.

Runtime-local feedback and budgets do not survive runtime recreation. A provider
that ignores cancellation retains the in-flight lock until it settles. These
tradeoffs are documented rather than hidden behind implicit retries or overlap.

## Revisit when

Representative session evaluations show useful notices versus false alarms,
observed input/output usage and latency, or a measured advantage for another
model. Reconsider persistence and scheduling if resets or context omissions harm
the experiment. A production rollout or any observer-driven action needs a new
explicit decision; passing deterministic tests alone is not sufficient.

## Desktop controls follow-up — 2026-10-04

The user explicitly requested and approved a permanent statusbar indicator with
details and a session toggle, plus model selection and other knobs in Desktop
settings. Approval is in this conversation, not a separate durable artifact.
The [current spec](../../specs/heads-up-observer.md) governs this extension.

Use statusbar/popup for live, session-owned control; keep the finding itself
above the composer. Remove duplicate enable/check actions from the composer menu.
Expose observed last-check outcomes rather than presenting silence as success
or a minimum interval as a scheduled next launch. Read-only refresh must not
resume the parent or start inference. Pending controls and popup focus belong
to one session/runtime, including while settings load asynchronously.

Store Desktop defaults in the existing `pix-desktop.jsonc` profile under
`headsUp`, independent of standalone TUI observer configuration. Reuse the
normal conflict-checked settings editor and provider/model picker. Defaults
apply on new/reloaded runtimes; a popup switch only changes its current runtime.
Immediate propagation to all running sessions was not chosen because it could
cancel or silently enable background requests in unrelated tabs. Shared TUI
defaults were rejected to preserve the requested Desktop separation. Existing
Desktop users of standalone `heads-up.jsonc` must set the new Desktop profile;
no automatic migration or default enablement is performed.

This changes discoverability and configuration, not the observer's inference
prompt, model-quality claims, or permission to act on findings. Browser
integration uses synthetic model/native IPC to verify the UI contract; native
window behavior and real-model usefulness remain distinct verification scopes.
