---
kind: spec
status: active
---

# Heads up observer (experimental, opt-in)

Rationale and alternatives: [0034 — Bounded, opt-in Heads up observer](../docs/decisions/0034-heads-up-observer.md).

## Behavior

Pix offers an optional passive observer of a coding conversation. It looks for
one concrete, consequential, probably unnoticed contradiction or tradeoff in
the current task. It is not a code reviewer or an enforcement mechanism: it
cannot inspect files independently and must not claim facts absent from its
input. The normal result is no notice.

The implementation uses one provider-neutral registry inference, not a child
agent, forked agent session, subprocess harness or tool loop. The request has
no tools, tool choice `none`, low reasoning, zero retries and no implicit model
fallback. The initial model reference is `openai-codex/gpt-6-luna`, a candidate
for evaluation rather than a measured quality winner. Missing credentials or
model availability is reported as a controlled status, never replaced silently
with the parent model. Ordinary work in the parent is never awaited or resumed
by an observer result.

It is off by default. `/heads-up on` enables the current runtime/session;
`/heads-up off` cancels work. `/heads-up check` explicitly checks an enabled
observer, and `/heads-up status` shows phase, model and recorded counters.
`/heads-up model provider/model-id` chooses its model without changing the main
agent. Commands are registered extension commands; ACP executes them out of
band without taking over the active parent run.

TUI configuration is read from the agent directory's `heads-up.jsonc`, followed
by a trusted working directory's `.pi/heads-up.jsonc`. Desktop instead reads the
`headsUp` object in `~/.config/pi/pix-desktop.jsonc`, followed by the same object
in a trusted working directory's `.pi/pix-desktop.jsonc`. Desktop never inherits
standalone `heads-up.jsonc` or TUI `pix.jsonc`; no automatic migration is made.
Invalid JSONC and oversized files are ignored. Standalone files are bounded at
16 KiB; a complete Desktop profile may be up to 1 MiB. Comments and trailing
commas are accepted. `enabled: true` explicitly opts new/reloaded runtimes in;
`model` is a provider/model reference and numeric settings are clamped.

Desktop Settings → Observer edits these saved defaults using the existing
conflict-checked JSONC save flow, preserving unrelated keys and comments. It
offers a model picker, default-enable switch, completed-turn cadence, minimum
interval, and an advanced group for per-check/hour input limits, checks per
hour, output tokens, timeout and notice lifetime. Timing fields display seconds
and persist milliseconds. Fields have labelled controls and reset-to-default
actions; settings search can reveal advanced fields. A trusted project override
can supersede user defaults. Saved changes apply to new or reloaded runtimes,
not silently to active sessions. Runtime toggles/commands never write config.
On/off state, deduplication and limits are runtime-local and reset on runtime
recreation; usage entries are durable. There is no cross-session knowledge profile.

## Context and cadence

Automatic checks need at least six new completed agent turns and sixty seconds
since the last check (or initial runtime creation). They run from `turn_end`
without returning its inference promise. An open notice suppresses further
automatic checks. A manual check can bypass cadence, not enablement,
concurrency, availability or budgets.

Default limits are twelve checks per rolling hour, a 16,000-character serialized
observation payload, 192,000 payload characters per rolling hour, 900 output
tokens and a twenty-second request timeout. The fixed system instructions are
additional to the payload character budget. Reservations are made before the
request and are not refunded on errors; toggling or changing models does not
reset limits. These are initial experiment defaults, not measured optimal
values. Full token usage is reported separately from payload character limits.

Immediately before a real check, Pix reads its existing in-memory, active,
compaction-aware session projection. Context edits and branch changes are
respected instead of resurrecting raw history. It retains the first surviving
user request, recent user instructions and a bounded set of recent work records;
user requirements are separately tagged from assistant claims. Only bounded
text and bounded tool arguments/results are included, with real source-entry
IDs. Thinking, image bytes and full logs are excluded. Omission/clipping is
explicit. No full-history scan occurs per render or per streamed token.

Common credential patterns, private-key blocks and control sequences are
filtered. This is best-effort redaction, not proof that arbitrary project text
contains no secrets or personal data. Enabling an observer sends the selected
conversation excerpts to its configured model provider. Input data is not
trusted instruction text; unknown evidence IDs, extra fields, malformed or
truncated replies and tool calls are rejected. Valid evidence IDs establish
provenance, not the correctness of a model inference.

## Presentation and feedback

At most one short notice appears above the composer. TUI uses a keyed widget;
Desktop consumes the structured `heads-up` session-state channel. Desktop
validates bounded payloads and rejects stale revisions and retired instances.
Feedback actions include already-known, irrelevant and dismiss, keyed by notice
ID so a stale button cannot clear a newer notice. Recent shown/feedback topics
are included in subsequent checks; exact normalized duplicates are suppressed.

`/heads-up explain` expands existing evidence in TUI. Desktop has an evidence
expander and feedback actions; expansion never makes another model request.
Desktop management lives in a persistent statusbar Observer item, not in the
composer actions menu. Off, waiting, checking, finding, unavailable/error and
limited states are distinguished. Only a real checking phase animates. A draft
or unready runtime still allows opening settings, but not session controls.
Cards expire after five minutes by default, including while the main agent is
idle; the existing evidence/feedback card stays above the composer.

The statusbar popup contains a current-session toggle, explicit Check now and
an Observer settings deep link. It shows the actual runtime model, last check
time/result/duration, completed-turn progress, interval eligibility, rolling
request/input reservations, and recorded input/cache/output tokens. Never-run,
no finding, finding, suppressed duplicate, malformed reply, error, timeout and
cancellation are distinct results. Older snapshots without optional `details`
remain readable; missing details are unavailable, not claimed successful checks.
Eligibility time is not a promised launch time: automatic work still requires
a completed agent turn. The earliest reservation expiry is not a full reset.

Opening the popup may issue `/heads-up snapshot`, a quiet out-of-band state
refresh with no inference, context assembly, transcript notification, or parent
run. Without a snapshot it is sent only for a registered extension command.
Opening cannot enable the feature or alter the composer. Counter refreshes can
clear a fully expired limit without starting a check. Its display clock only
runs while the popup is open. Pending button requests, session switches,
disconnects and retired runtime instances are ownership-guarded. The popup
closes on owner replacement/unready transitions; a first snapshot completing
initial loading does not close it. Escape restores trigger focus; outside
click dismisses; popup controls are keyboard reachable. Closed UI does not
intercept Escape. Popup geometry stays inside narrow viewports. Settings deep
links wait for asynchronously loaded sections and focus the Observer heading.

`/heads-up discuss` in Pix TUI, or Desktop's Insert question action, only fills
an empty composer with no attachments and no blocking dialogue. It never sends
the draft, overwrites user text or starts a parent turn. Copied evidence is
labelled untrusted; attachment mentions and effort-shortcut words are neutralized.
No number-key interception, automatic modal dialogue, generated learning page
or auto-fix exists in this experiment.

## Lifecycle, accounting and failure cases

Each controller owns one runtime/session. New genuine user input, stop/error,
disable, model changes, compaction, branching or shutdown invalidates pending
results. Normal subsequent tool turns do not invalidate a result solely because
the main agent progressed. Session replacement cannot publish a late result to
the new session. Teardown clears timers and abort listeners.

Timeout actively aborts inference. If a provider ignores cancellation, the UI
stops waiting but the physical in-flight lock remains until the request settles;
no queue of overlapping requests is created. A permanently non-settling provider
therefore requires runtime recreation before checking again.

Finalized replies with valid usage are recorded as `appendUsage("heads-up", ...)`
on the captured originating session manager, including stale/aborted replies
that still supply usage. Provider errors without usage cannot be reconstructed.
An absent accounting capability refuses work; an accounting failure blocks
subsequent checks. Spend is never attributed to whichever tab happens to be
active. There is no external feature analytics or transcript logging; structured
runtime status is local UI state, not a new external telemetry service.

`PI_OFFLINE` is a hard stop. Print/JSON, standalone RPC without the Desktop
bridge, UI-less draft runtimes and suite subagent runtimes do not activate the
observer. This feature does not inherit into ordinary async-subagent workers.

## Implementation

- `src/bundled-extensions/heads-up/index.ts`
- `src/bundled-extensions/heads-up/controller.ts`
- `src/bundled-extensions/heads-up/config.ts`
- `src/bundled-extensions/heads-up/context.ts`
- `src/bundled-extensions/heads-up/inference.ts`
- `src/bundled-extensions/heads-up/parser.ts`
- `src/bundled-extensions/heads-up/presentation.ts`
- `src/bundled-extensions/heads-up/settings.ts`
- `src/bundled-extensions/heads-up/usage.ts`
- `src/bundled-extensions/heads-up/contract.ts`
- `src/app/runtime.ts`
- `desktop/src/app/heads-up.svelte.ts`
- `desktop/src/components/HeadsUpCard.svelte`
- `desktop/src/lib/heads-up.ts`
- `desktop/src/lib/observer-status.ts`
- `desktop/src/components/ObserverStatus.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/app/desktop-shell-view-model-services.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/settings/SettingsObserver.svelte`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsNumberInput.svelte`
- `desktop/src/components/settings/SettingsSwitch.svelte`
- `desktop/src/lib/settings.ts`
- `desktop/src/lib/settings-viewport.ts`
- `desktop/src/lib/settings-navigation.ts`
- `desktop/src/lib/default-desktop-config.ts`
- `src/schemas/pix-desktop-schema.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `desktop/src-tauri/src/backend_runtime.rs`
- `scripts/heads-up-eval/cases.ts`
- `scripts/heads-up-eval/scoring.ts`
- `scripts/heads-up-eval/runner.ts`
- `scripts/heads-up-eval/options.ts`
- `scripts/heads-up-eval/run.ts`

## Tests

- `tests/heads-up-controller.test.ts`
- `tests/heads-up-context.test.ts`
- `tests/heads-up-extension.test.ts`
- `tests/bundled-question-extension.test.ts`
- `desktop/src/app/heads-up.svelte.test.ts`
- `desktop/src/lib/heads-up.test.ts`
- `desktop/src/components/HeadsUpCard.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/config.test.ts`
- `tests/heads-up-eval.test.ts`
- `tests/heads-up-status.test.ts`
- `tests/heads-up-settings.test.ts`
- `desktop/src/app/observer-status-integration.test.ts`
- `desktop/src/lib/observer-status.test.ts`
- `desktop/src/components/settings/SettingsObserver.test.ts`
- `desktop/src/lib/settings-viewport.test.ts`
- `desktop/scripts/observer-smoke.mjs`
- `desktop/scripts/fixtures/ObserverSmoke.svelte`

## Verification

Deterministic tests use fake clocks/providers, real in-memory session projection,
out-of-band ACP command fixtures and server-rendered UI. They establish runtime
behavior, not real-model precision, usefulness, latency or pricing. Live model
quality needs a separate opt-in evaluation on representative coding sessions.

`npm --prefix desktop run test:observer` exercises real Svelte components, browser
events, model selection and the settings save contract using synthetic IPC/state.
It checks read-only popup opening, explicit controls, cancellation, tab/runtime
replacement, Escape/Tab focus, cold settings navigation, seconds conversion,
comment/parent-model preservation and narrow popup bounds. Evidence is written
under `.pi/artifacts/observer-ui-*`. This is not a native Tauri/window-system
test and never contacts a model or writes a real user profile.

The [Heads up evaluator](../docs/heads-up-eval.md) supplies a synthetic development
corpus and an opt-in, sequential live-model runner. `npm run eval:heads-up` only
validates/lists fixtures; `--live` authorizes real inference using the production
context builder, prompt and parser. The CLI has a whole-matrix request ceiling,
no retries/fallback or judge model, and never reads real conversation histories.
It reports false positives, missed warnings, source/consequence-anchor matches,
invalid replies, incomplete runs, latency and recorded usage separately. Lexical
scoring is a proxy; every emitted notice still requires human semantic review.
See that guide for commands, limits, interpretation and artifact retention.
