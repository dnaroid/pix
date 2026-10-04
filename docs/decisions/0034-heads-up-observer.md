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
apply on new/reloaded runtimes; a popup switch originally changed only its current
runtime (the persistence follow-up below supersedes that part).
Immediate propagation to all running sessions was not chosen because it could
cancel or silently enable background requests in unrelated tabs. Shared TUI
defaults were rejected to preserve the requested Desktop separation. Existing
Desktop users of standalone `heads-up.jsonc` must set the new Desktop profile;
no automatic migration or default enablement is performed.

This changes discoverability and configuration, not the observer's inference
prompt, model-quality claims, or permission to act on findings. Browser
integration uses synthetic model/native IPC to verify the UI contract; native
window behavior and real-model usefulness remain distinct verification scopes.

## Desktop compact controls and persistence follow-up — 2026-10-04

Status: accepted; supersedes runtime-only Desktop enablement above, not TUI
enablement or profile-default propagation. User approval is in this conversation:
icon-only eye, grey off / primary enabled / flicker during work, dynamic-only popup,
the standard switch, and retaining enablement after application restart.

Evidence: the old popup command called only `setEnabled`, and initialization read
only profile defaults, so toggling was lost on runtime recreation. Decision: save
explicit Desktop on/off as non-message custom session metadata via the SDK and
restore the last valid choice for that session before publishing enabled state.
Branch navigation does not rewind a session-owned preference. Existing settings
still supply the model and limits. No automatic check runs simply on restoration.

Alternatives: writing global defaults would affect unrelated/new sessions;
browser-local storage would separate ownership from durable native sessions and
require replaying commands after reconnect. Neither is necessary to retain the
current-session switch. Consequences: forks inherit metadata only when present
in their copied branch, and drafts without a conversation are not persisted.
TUI behavior, runtime counters/budgets and inference policy remain unchanged.
Revisit if a global quick-toggle or explicit reset-to-default action is requested.

Keep only the eye in chrome and live diagnostics in the popup; static model and
budget settings remain in Settings. This removes duplicated configuration rather
than hiding diagnostics. The standard switch preserves keyboard semantics.

## Desktop limited indicator follow-up — 2026-10-04

Status: accepted; supersedes primary-for-all-enabled states in the compact
controls decision above. User requested a static amber eye for budget-blocked
checks, with the limit and earliest known quota release in tooltip and popup.
The [current spec](../../specs/heads-up-observer.md#presentation-and-feedback)
defines the presentation contract.

Evidence: runtime publishes `limited` for both hourly check and input budgets;
`windowResetsAt` is the earliest reservation expiry, not a full reset or scheduled
check. Decision: use the semantic warning color, prioritize limited over a live
notice in status chrome, and restore primary only on a runtime state update.
The finding card remains untouched. Do not infer recovery from wall time, start
inference, or add polling. Keeping primary hides blocked work; guessing a full
reset from the earliest expiry misrepresents the input budget. Revisit if runtime
adds authoritative next-eligibility notifications. No inference policy changes.

## Delegated evidence follow-up — 2026-10-04

Status: accepted first increment for the same opt-in experiment. The user asked
to continue the delegated-work handoff; that handoff explicitly permits bounded
child reports while authoritative mutation/test provenance is unavailable.
The [governing spec](../../specs/heads-up-observer.md#delegated-work-first-increment)
defines the scope and limitations.

Evidence: generic async completion notices are custom messages, excluded by the
observer's transcript reducer; parent summaries can therefore hide a concrete
child design conflict. Compact child events contain tool names/counts rather than
authoritative file mutations, command arguments or test output. Structured results
derive from the visible child report, not independent verification. Assumption:
attributing a concrete reported conflict can still be useful, but usefulness and
false-positive rates require semantic evaluation.

Decision: use a passive runtime bridge with launch ownership captured before
async routing, and bounded final reports after retries/fallback. Keep a single
parent observer and unchanged follow-up/wait arbitration. Treat reports as claims,
not inspected code or verified tests. Add a coalesced completion opportunity under
existing budgets/interval/concurrency, so parent settlement does not strand new
evidence. Retire launches across lifecycle boundaries instead of adopting old work.

Alternatives deferred: authoritative child-tool instrumentation is a larger
future provenance increment; global worktree diffs cannot attribute changes among
concurrent workers; one observer per child expands cost and ownership complexity;
using only parent follow-ups retains the original omission and delivery dependency.

Consequences: child summaries may be incomplete or wrong, clipping can hide a
correction, and lifecycle invalidation can drop late reports. This does not close
the verified-diff/test-evidence gap. Revisit when child mutation/test provenance
exists or representative sessions show omissions/false positives; do not infer
production readiness from synthetic eval scores alone.

## Settled checks and evidence-driven card review — 2026-10-04

Status: accepted. This supersedes the original `turn_end` launch policy and
open-notice suppression of all automatic requests, not the single-card,
opt-in, bounded-inference decision. Contract: [Heads up observer](../../specs/heads-up-observer.md).

Context: the user reported a HUD test failure warning after a successful rerun,
then explicitly chose successful final agent settlement over intermediate turns
or todo boundaries. The user also approved rechecking an open card when new
evidence arrives after work completes, rather than periodic polling or a stack.

Evidence: in session `01a10822-1e93-779e-866f-13f50013a78b`, the failed codemode
result `0eb25993` was persisted at 18:55:01.651Z; Observer usage `64c7906f` at
18:55:06.939Z; test-expectation fixes `565271fd` at 18:55:19.024Z; the successful
shell rerun `0a8f9e7e` (82/82, six files) at 18:56:01.178Z; successful typecheck
`4edced57` at 18:56:15.826Z. The user's later inserted notice `2050c618` cited the
failed result. No Observer usage lies between that completed check and the
inserted notice. The runtime accounts usage after the provider completes, before
publishing. This supports an early assessment left visible across repairs, not
a completion delayed until after the retest. Exact inference snapshots and UI
delivery timestamps were not persisted, so those cannot be reconstructed.

Code evidence: ordinary results did not invalidate inference; `generation`
guarded lifecycle ownership and `revision` ordered UI snapshots. Open cards
blocked automatic reassessment. Context selection also serialized work backwards
and could skip a large newer record while backfilling an older small failure.
Those are independently reproducible risks, not proven causes of this incident.
Codemode and shell share the tool-result reducer; nested codemode calls arrive
as bounded aggregate text. There is no demonstrated shell-specific filtering bug.

Decision and scope:
- Accumulate completed turns, launch only after successful final settlement
  (after queued continuations), or accepted delegated evidence while idle.
  Failed/aborted settlement is not a trigger. Manual checks remain immediate.
- Refresh projected evidence before publishing a finding or applying a review.
  Changed bounded user/tool/delegated evidence, edited cited assistant text, or
  an active parent during automatic inference causes a coalesced fresh check,
  not delivery of the old verdict. Preserve lifecycle tokens and physical lock.
- Review the existing card on settled changed evidence, within the same
  interval/input/hour limits. The model reassesses that problem, not a new topic:
  still supported means keep the card identity and original TTL; `none` removes
  it. Unrelated successful checks do not imply resolution. No new evidence means
  no automatic paid review. Closed cards cannot be resurrected by late results.
- Serialize selected records chronologically and keep a contiguous recent work
  suffix under the total budget, plus pinned instructions. Do not fill a gap left
  by a large fresh result with smaller old failure evidence.

Alternatives: periodic polling spends on unchanged context and can observe
intermediate repairs; todo completion is optional and does not prove testing is
finished; a prompt-only change cannot enforce delivery freshness or restore
omitted records; blanket invalidation on every event starves useful findings;
command-name/exit-code heuristics cannot reliably match arbitrary nested tools.
A multi-card stack changes selection/UX and retains more stale claims, so remains
out of scope.

Consequences and limits: warnings arrive later and brief problems fixed within
one run are normally never shown. Changed evidence may defer an unrelated valid
finding, but reassessment can retain it; cost remains bounded. A visible card can
remain during work, a failed/refused review or until TTL. Model inference is still
fallible; prefix clipping and bounded history can omit relevant evidence, and
long records can reduce useful retained context. Deterministic tests establish
scheduling, freshness, payload and ownership behavior, not model accuracy.
Revisit on measured missed warnings, review cost/starvation, or availability of
authoritative per-check identity/provenance; do not add polling or command
matching based solely on this incident.

## Bounded active stack — 2026-10-04

Status: accepted. Supersedes the single-card/discovery suppression portions above,
not settlement, freshness, opt-in or inference budgets. Contract:
[Heads up observer](../../specs/heads-up-observer.md).

Context and evidence: after the freshness fix the user explicitly requested the
proposed stack because one open card could hide other independent problems.
The approved proposal is up to three active findings, one visible card with
counter/navigation, and one combined review/discovery request under the existing
budgets. No claim is made about another product's undocumented stacking behavior.

Decision: return a complete supported set of up to three cards. Retained cards
use their existing IDs and preserve age/expiry; resolved/unsupported cards are
omitted. New cards use null IDs at the model boundary and receive runtime IDs.
Strict validation rejects the entire malformed/truncated/unknown-ID response;
it must not partly remove old cards. Exact topic duplicates merge; semantic
independence and relevance remain model judgments. Keep surviving cards in their
prior order, then append discoveries. Navigation changes selection only, never
requests inference or extends TTL. Desktop selection is local and scoped to its
runtime/session; TUI prev/next updates the selected snapshot member. Old Desktop
singleton snapshots remain readable via optional `notices` compatibility.

Concurrency: one physical inference lock/reservation serves the whole stack.
Changed evidence still rejects completion; membership changes (dismiss/expiry)
during assessment reject it atomically, preventing resurrection. Selection changes
do not cancel useful assessments. Independent expiries share one earliest-expiry
timer. Runtime replacement/lifecycle invalidation clears the stack.

Alternatives: retaining a singleton misses simultaneous problems; separate review
and discovery calls multiply spend; an unbounded queue retains more stale claims;
showing all cards at once crowds the composer. A full-set reply is simpler to
validate atomically than separate add/update/remove operations.

Consequences/assumptions: three is a bounded UX choice, not a measured optimum.
The unchanged output budget demands concise replies; truncation fails closed.
Descriptors can be clipped within small input budgets, explicitly labelled, while
preserving all active IDs. The deterministic suite covers limits, lifecycle,
selection, ownership and schema, not model accuracy. The current live-eval corpus
still expects one problem per positive fixture, so extra cards require human review
and cannot earn a proxy pass. Revisit after measured missed independent findings,
semantic duplicates, truncation rates or review cost; no increased budgets or
periodic polling is approved by this change.

## Strict visible freshness follow-up — 2026-10-04

Status: accepted. Supersedes retaining visible assertions across new work and
failed/refused reassessment, not the bounded-stack or inference-budget decisions.
Contract: [strict visible freshness](../../specs/heads-up-observer.md#strict-visible-freshness).

Context: after the stale HUD warning and bounded-stack work, the user requested
currently supported cards rather than temporary problems that may already have
been fixed, and approved hiding unconfirmed cards without increasing limits.
Evidence: rejecting stale inference responses alone left previously displayed
cards visible during later repairs, errors and quota refusals. The SDK can emit
message completion before persistence, so projection-only comparisons leave a
delivery race. Assumption: conservative visibility is preferable to presenting
an old assessment as current; this does not establish model accuracy.

Decision: hide the complete visible stack synchronously on parent start or
user/tool/delegated evidence completion. Keep bounded private candidates with
original IDs and TTLs. Publish only neutral awaiting-review state, and restore
only cards supported by a successful current assessment after settlement.
An evidence-event revision complements projection comparison and lifecycle tokens.
Manual checks remain immediate but cannot publish claims while the parent runs.
Errors, unavailable context, malformed responses and limits never restore hidden
claims. Existing budgets, request ownership/accounting, expiry and no-polling
policy remain unchanged; neither hiding nor a refusal queues repeated retries.

Alternatives: TTL-only retention keeps known-stale assertions visible; optimistic
retention until review repeats the reported failure; polling or higher budgets
adds cost without guaranteeing truth; clearing all identity loses stable review
and expiry semantics. Consequences: cards can remain absent while review is
blocked, and clipping can prevent reconfirmation. Hidden does not mean resolved.
Revisit if measured missed findings or excessive conservative hiding outweigh
stale-warning risk, or authoritative fresh repository evidence becomes available.
