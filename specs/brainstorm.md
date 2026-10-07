---
kind: spec
status: active
---

# Configured multi-model brainstorm and audit council

## Desktop persistent sessions

[0019](../docs/decisions/0019-desktop-persistent-council-sessions.md) changes new
Desktop councils only. ACP owns one native session per roster slot across all
five rounds, including the wait for the parent's draft. `[BS:<run-id>]` names
are recognition aids; explicit run, orchestrator, slot and native session IDs
are authoritative. The status-bar council popup displays round/status and participants,
opens their existing sessions and supports returning to the orchestrator. Opening
a participant must not create another runtime writing the same history. Direct
user writes/mutations are blocked while the orchestrator owns the participant.
That write lock must not block selecting another conversation tab or returning to
the orchestrator; navigation checks workspace/connection readiness independently
of the active participant's mutation permission.

Closing a participant tab hides its view only, including after council completion:
it does not send `session/close`, cancel work, delete history, or forget runtime
and activity state. The council popup can reopen that same participant session. Active-tab
closure selects another visible conversation or opens the draft start tab. Ordinary
conversation tab closure retains its existing stop/close behavior.

The Desktop status bar shows a brain icon (not a `BS` label) and round `N/5`
for the active orchestrator or its participant. Button activation (click, Enter
or Space) toggles the topic, council state, and each participant's model, name,
state and round. Hover or mere focus never opens it. There is no Session inspector.
When several runs exist, the compact
indicator prioritizes the latest nonterminal run, falling back to the latest run;
the custom click surface lists all runs and its lower edge touches the trigger's
top, matching Plan without a visual gap. Pointer departure does not close it;
repeat activation, Escape, outside click or focus departure dismisses it.
No browser-native tooltip is used. See [status-bar click popups](../docs/decisions/0048-status-bar-click-popups.md).
Terminal runs remain visible while their snapshot is
available; this indicator does not introduce host-crash recovery or new persistence.

The suite calls a scoped authenticated loopback ACP bridge, not nested subagents,
when ACP supplies its host capability. Children do not inherit that capability.
Models remain exact and research tools read-only. Cancellation/deadlines and host
teardown stop owned work; a failed or lost participant must not be replaced by a
fresh session to impersonate continuity. Run completion/incompletion releases
ownership; failure to confirm release is reported without undoing a saved proposal.

The v4 manifest adds `execution: "desktop-sessions"`. Review honors the stored
execution mode; a missing host is not permission to fall back to fresh workers.
Unknown execution values are rejected. Active councils cannot resume after losing
their host. Legacy and TUI runs omit this field and retain fresh nested subagents.

Round 1 supplies the brief independently. Later Desktop prompts append only newly
completed peer answers, never current-round siblings, and round 5 adds the parent
draft. Own answers and older peer turns are already in that participant's history.
Safety/round instructions remain explicit each turn. Response files, hashes,
quorum, ledgers/matrix and the five-round parent workflow remain unchanged. This
reduces prompt replay, not the number of paid participant turns; savings have not
been measured. Freeform orchestration and persistent TUI participants are deferred.

## v4 protocol (2026-10-03)

Accepted in [0017](../docs/decisions/0017-brainstorm-v4-protocol-storage.md).
The five-round lifecycle below is unchanged; v4 changes storage, roster,
history and failure tolerance:

- Roster: an absent/`null` `brainstorm.models` derives the roster from enabled
  `frontierModels` in order (max 6); an explicit list replaces it exactly.
- Per-model thinking via `brainstorm.thinkingOverrides` (exact ref, then bare
  model id, then `brainstorm.thinking`); default `zai/glm-5.3 = max`.
- Protocol root `brainstorm.outputDir` (default `.pi/brainstorms/`, outside the
  knowledge base, confined to the project, no symlinked segments). `finalize`
  with `publish=true` copies only the final proposal to
  `docs/brainstorms/<run>.md` with a pointer to the local protocol;
  `docs/brainstorms/` remains an accepted legacy run root.
- Manifest `pi-brainstorm-v4`: responses live in `rounds/<id>.md`; the manifest
  keeps id/model/file/SHA-256/chars, optional advisory script warnings and
  declared gaps. Continuation re-verifies every hash.
- Quorum `brainstorm.quorum` (2–6, default `max(2, roster − 1)`, never above the
  roster): failed/timed-out participants are declared gaps rendered in
  `discussion.md`; fewer successes than the quorum fail the round.
- Bounded history: rounds 1–4 end with a `## Ledger` table; later rounds receive
  the previous round in full and older rounds as ledgers (in round 4 also the
  participant's own earlier answers in full). `discussion.md` starts with a
  position matrix built from ledgers. A missing ledger degrades to a bounded
  excerpt.
- Prompt rules: slot-prefixed IDs (`P<slot>-…`), "Fixed decisions" reopened only
  under `REOPEN:` with new evidence, no repeated discovery after round 1, answer
  in the brief's language.

Known residual risk: finalization replaces `proposal.md` before optional
publication and final manifest persistence; a later error/abort marks the run
incomplete without a retry path. See also
[0012](../docs/decisions/0012-isolate-suite-module-loading.md) for how the WIP was
integrated.

## Behavior

The shared pi-tools-suite `brainstorm` module replaces the local brainstorm skill.
`/brainstorm [--mode auto|brainstorm|audit] [--models provider/model:effort,provider/model:effort] <topic and constraints>` queues a parent request to the model-only
`brainstorm` tool. An empty command shows usage and launches nothing. The tool
is for explicitly requested councils, not automatic delegation of ordinary work.

Without a flag (or with `--mode auto`) the parent selects the scenario from the
intended outcome and conversation: creation/development of alternatives means
`brainstorm`; evaluation of existing material against criteria means `audit`.
The presence of a document or a keyword alone is not the classifier. Mixed goals
require clarification of the primary outcome, not two silently launched councils.
An explicit `--mode brainstorm` or `--mode audit` overrides inference; conflicts
with the requested outcome require clarification, not a silent switch. The parent
announces its selected mode and reason before paid work. This is a model-facing
instruction contract, not deterministic natural-language classification, and adds
no classifier model call. Only leading flags are parsed (space or `=` form, either order);
invalid/duplicate leading options and empty topics queue no request.

`--models` selects a run-only ordered roster: 2–6 distinct exact `provider/model`
references, each with an explicit `:effort` suffix (`off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`), comma-separated without spaces. The last colon
separates effort, preserving model IDs containing colons or slashes. Duplicate
model identities with different efforts are still rejected. Missing/invalid effort,
wildcards and malformed rosters fail before paid work. The parent passes this
exact array as the tool's `models` argument to `run`; it must not pick its own
override. Without `--models`, it omits that argument and uses configured defaults.
This forwarding is a parent instruction, not a deterministic slash-to-tool binding.
User/project settings are never edited. See [0022](../docs/decisions/0022-brainstorm-run-roster.md).

Before paid work the parent prepares a brief with goal, constraints, non-goals,
success criteria, known evidence and labeled assumptions/open questions. It asks
the user only about material uncertainty that could change the decision, not for
mandatory approval when the input is sufficient. This is a parent prompt contract;
the tool requires nonempty bounded brief text, not semantic proof of clarification.
For audit, the brief also identifies readable target paths or supplied excerpts,
version/revision, author intent, criteria, scope/exclusions and coverage limits.
The parent checks availability first and asks for missing/inaccessible material;
a topic alone is not evidence. Source files are not frozen or snapshotted by the
engine, so citations must identify the inspected version and limits.

`brainstorm(action="run", mode="brainstorm"|"audit", topic, brief, models?)` runs the first four rounds using the exact
ordered roster resolved from pi-tools-suite.jsonc (`brainstorm.models`, or enabled
`frontierModels`), unless the user supplied the run-only `models` array:

In `brainstorm` mode:

1. Independent read-only proposals, without access to other participants' answers
   in the prompt.
2. Development and combinations: improve peers' ideas and create attributed
   hybrids, deferring adversarial elimination.
3. Critical evaluation against the brief: trade-offs, failure modes,
   counterarguments and disconfirming tests, without majority voting as proof.
4. Revised proposals: same-model authors address objections, adopt better peer
   ideas with attribution, and explain accepted/rebutted/unresolved criticisms.

In `audit` mode:

1. Independent findings: inspect the target against criteria and author intent;
   cite sections/paths and quotes or concrete evidence; disclose coverage gaps.
2. Cross-check and coverage: verify peers against the target, deduplicate with
   finding/participant lineage, identify omissions and unsupported assertions.
3. Critique of findings: counterarguments, false-positive checks and alternative
   explanations; retain/reject/defer findings based on evidence, not model votes.
4. Priorities and minimal fixes: severity/impact/dependencies, confidence assessed
   separately, author-intent-preserving corrections and concrete validation tests.

TUI and legacy runs use fresh participants with stable model/slot identities;
new Desktop runs use the persistent sessions above. Rounds 2–5
never see sibling answers from the current round; prior history is bounded as
described in the v4 section (previous round in full, older rounds as ledgers). The parent reads the saved brief/discussion and submits a draft through
`brainstorm(action="review", runDir, proposal)`. This preserves `draft-proposal.md`
and runs round 5 with the original configuration snapshot: every participant checks
the draft for omissions, misrepresentation, unsupported consensus and missing
trade-offs, with cited corrections and residual dissent. No recursive review or
unbounded debate is started.
For audit, round 5 checks report substantiation, citations, severity versus
confidence, false positives, missing coverage, dissent, fix scope and validation.
Mode is fixed at `run`, stored in the manifest and returned in run/review results.
The tool rejects missing/`auto`/invalid execution modes and rejects any mode
argument on review/finalize; they use the stored mode. The internal workflow
function retains a default of `brainstorm` for existing programmatic callers.

Only after that review can the parent correct the final proposal through
`brainstorm(action="finalize", runDir, proposal, revisionNotes)`. `revisionNotes`
records changes from the draft and how material findings were accepted, rejected
with rationale or deferred with a test, citing participant/issue IDs. The requested proposal includes
problem/constraints, alternatives, recommendation/rationale, agreements, minority
views/open decisions, risks/assumptions, validation and phased implementation with
acceptance criteria. Consensus is not forced and implementation is never started
by the module. Synthesis quality is a parent responsibility, not mechanically
certified by the tool.

Audit synthesis instead uses an audit-report template: target/version, intent,
criteria/scope and gaps; executive summary; findings (stable ID → source
section/path and quote/evidence → problem → impact → severity → confidence →
basis/counterevidence → minimal fix → validation); rejected/contested findings;
residual risks and prioritized fixes/tests. Dedupe preserves finding lineage.
Severity is not confidence, agreement is not proof, and no findings is a valid
result with stated coverage limits. Untested fun, balance or performance claims
remain hypotheses for prototypes/playtests/measurements. A redesign is optional
and separate, not the default audit remedy. This evidence discipline is prompted,
not a machine-verified guarantee of valid findings.

Each invocation creates a unique
`<outputDir>/<date>-<topic-slug>-<random-id>/` (default `.pi/brainstorms/`)
containing `brief.md`, `discussion.md`, `proposal.md`, `manifest.json` and
`rounds/<response-id>.md`. Review adds `draft-proposal.md`;
finalization adds `revision-notes.md`. Discussion records each response under its
round, participant ID and model; adapter responses link raw source artifacts.
This is a protocol of emitted answers and decisions, not hidden model reasoning.
The proposal starts explicitly pending synthesis. Successful rounds 1–4 leave
`awaiting_synthesis`; review moves through `reviewing_synthesis` to
`awaiting_finalization`; successful parent finalization leaves `complete`.
Manifest v4 stores resolved mode, brief, config snapshot, response file
provenance/hashes, declared gaps, draft SHA-256 and optional `publishedPath`.
Raw child artifacts remain under `.pi/subagents/`. Legacy v1 artifacts remain
readable as documents but cannot continue under the new protocol; start a new run.
Original v2 five-round manifests without a mode may continue as `brainstorm`;
v3 and such v2 runs (inline texts, all participants required) are migrated to v4
on successful continuation. A mode-tagged v2 or a missing/invalid v3 mode
is rejected before council work/document mutation (apart from the transient lock).
Both modes retain the same directory and filenames: `proposal.md` is the final
audit report in audit mode; `draft-proposal.md` is its preserved draft.

## Configuration

The usual suite user/environment/project layering applies. `brainstorm.models`
accepts 2–6 distinct exact `provider/model` references (no wildcards) and replaces
the inherited list. When absent or `null`, the roster tracks enabled
`frontierModels` in order (max 6), including later frontier layers; fewer than two
models fail before paid work.

`brainstorm.thinking` defaults to `high`; `brainstorm.thinkingOverrides` maps
models to levels (default `{"zai/glm-5.3": "max"}`, `null` removes an entry or the
whole map). `brainstorm.timeoutSeconds` defaults to 600 per participant per round
(integer 30–1800). `brainstorm.outputDir` defaults to `.pi/brainstorms`.
`brainstorm.quorum` is optional (see above). Invalid settings raise configuration
errors, not silent roster substitution. Disable the module through
`modules.brainstorm: false` or the ordinary module disable mechanisms.

Run-only `models` entries replace the roster and override each selected model's
effort exactly, ahead of inherited exact/bare-id thinking overrides. Timeout,
output root and quorum policy remain configured: default quorum is recomputed
for the new roster; an explicit quorum above its size fails rather than being
silently lowered. The copied effective config is snapshotted for all five rounds
in both execution modes. Review/finalize reject any `models` argument and use the
stored roster/efforts even after settings change. Availability, auth, supported
provider effort handling and exact-model/no-fallback policies remain unchanged.

## Constraints and failure cases

- TUI and legacy runs use the existing `subagents` tool through SDK nested execution:
  hooks, permissions, usage attribution, availability/auth checks, retries,
  project concurrency and owned process lifecycle remain authoritative. The
  async-subagents tool and `research` role must be available. Explicit models
  have no fallback candidates; economy and role policies can reject them.
- Forced-current-model environment overrides and nonempty `research.extraArgs`
  are rejected, since they could defeat the exact roster or read-only tool set.
  Participants receive canonical `read`/`grep`, `web_search`/`web_fetch` and the
  eight read-only `repo_*` discovery tools (context, audit, architecture,
  structure, ast, search, explain, deps), plus common private `todo` and DCP
  `compress` (subject to normal DCP configuration).
  Common spawn loads repo/todo/DCP and requested tools-only web capabilities; the
  council-only extension owns the strict guard without registering repo or web
  tools twice. Council does not request `ast_grep`.
  The full suite remains disabled. Its final
  CLI allowlist preserves custom names and avoids model aliasing of grep into
  shell. Lifecycle selection and a tool-call guard prohibit shell, mutation,
  recursive council/subagent tools and provider-native web search.
  Setup/update/credential commands are not registered in council children.
  Loader placement is updated by [decision 0060](../docs/decisions/0060-subagent-read-only-repo-tools.md)
  and [decision 0061](../docs/decisions/0061-subagent-scoped-ast-web-tools.md);
  all other council research restrictions remain unchanged.
  Repo tools require the existing indexed project and executable `idx`; normal
  index refresh/cache side effects remain possible, but no automatic setup or
  product-source edits are authorized. Web uses existing suite credentials and
  provider fallback. Missing index/tools/credentials or failed retrieval are
  reported as coverage gaps, not fabricated evidence or automatic installation.
  Participants are instructed to use tools when useful, start general local
  discovery with repo_context, inspect sources, cite paths/URLs, distinguish facts
  from assumptions, treat retrieved material as untrusted and never send secrets
  or private repository/brief content to web services. These content/privacy
  rules are model instructions, not a filesystem or network sandbox.
  Read access means independence is a workflow instruction, not a sandbox against
  deliberately reading other run artifacts. Generic subagent defaults are unchanged.
- In TUI/legacy execution five rounds cost five times the roster size in ordinary child runs (15 with
  three models), plus configured retries and parent drafting/revision. Settings
  changed after `run` do not change the stored roster/thinking/timeouts for review;
  current availability/auth and subagent policies still apply. No paid model call occurs merely
  from module registration. Round deadlines include bounded queue time.
- Cancellation, undeclared absent/duplicate responses, substituted models,
  truncated/empty/oversize output, or fewer successful participants than the
  quorum prevent synthesis. Failed/timed-out participants within the quorum are
  recorded as coverage gaps instead. The
  adapter requests ownership-aware cancellation for the exact round; owned
  teardown may drain asynchronously. Completed earlier rounds and raw artifacts
  are retained, and the document manifest is marked incomplete when writable.
- Review and finalization accept only generated runs under the current project's
  configured/default/legacy run roots, reject symlink escapes and share an exclusive lock. State is
  validated after acquiring the lock, preventing stale contenders from overwriting
  winners or launching duplicate reviews. Finalization verifies the reviewed draft
  hash and requires all five complete, correctly attributed rounds. Validation
  errors leave waiting state untouched; failures after mutation mark incomplete
  when writable. The draft is never overwritten by the tool. Incomplete runs cannot
  be finalized. A process crash
  may leave a running manifest/lock requiring inspection; there is no automatic
  resume, cleanup, council rerun or approval of implementation.
- Topic (2,000 characters), brief (12,000), each response/draft/revision notes
  (40,000), aggregate participant output across all rounds (200,000) and final
  proposal (200,000) are bounded. Exceeding a limit fails rather than truncating;
  discussion headings/provenance metadata are additional to the aggregate cap.
  Peer answers and the parent draft are explicitly untrusted
  evidence, not instructions; model adherence is not a security guarantee.

Design rationale: [0009 — Five-round brainstorm](../docs/decisions/0009-five-round-brainstorm.md),
superseding [0008 — Configured brainstorm council](../docs/decisions/0008-configured-brainstorm-council.md).
Audit/routing extension: [0010 — Audit council modes](../docs/decisions/0010-audit-council-modes.md).
Research capabilities: [0011 — Council research tools](../docs/decisions/0011-council-research-tools.md).
Dependency: [async-subagents](async-subagents.md).

## Implementation

- `desktop/src/components/SessionBrainstormStatus.svelte`
- `desktop/src/components/StatusBarPopover.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/app/desktop-brainstorm-navigation.ts`
- `desktop/src/app/desktop-shell-view-model-services.ts`
- `desktop/src/app/desktop-status-bar-view-model.svelte.ts`
- `desktop/src/app/desktop-workbench-view-model-services.ts`
- `external/pi-tools-suite/src/brainstorm/config.ts`
- `external/pi-tools-suite/src/brainstorm/index.ts`
- `external/pi-tools-suite/src/brainstorm/subagents.ts`
- `external/pi-tools-suite/src/brainstorm/desktop-sessions.ts`
- `external/pi-tools-suite/src/brainstorm/research-tools.ts`
- `external/pi-tools-suite/src/brainstorm/research-extension.ts`
- `external/pi-tools-suite/src/async-subagents/work-tools.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/src/repo-discovery/subagent.ts`
- `external/pi-tools-suite/src/async-subagents/core/child-tools.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/brainstorm/workflow.ts`
- `external/pi-tools-suite/src/brainstorm/continuation.ts`
- `external/pi-tools-suite/src/brainstorm/prompts.ts`
- `external/pi-tools-suite/src/brainstorm/modes.ts`
- `external/pi-tools-suite/src/brainstorm/instructions.ts`
- `external/pi-tools-suite/src/brainstorm/storage.ts`
- `external/pi-tools-suite/src/brainstorm/ledger.ts`
- `external/pi-tools-suite/src/config.ts`
- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/prompt-commands/index.ts`
- `src/schemas/pi-tools-suite-schema.ts`
- `schemas/pi-tools-suite.json`

## Tests

- `desktop/src/components/SessionBrainstormStatus.test.ts`
- `desktop/src/components/StatusBarHover.test.ts`
- `desktop/src/app/desktop-brainstorm-navigation.test.ts`
- `external/pi-tools-suite/test/brainstorm/desktop-sessions.test.ts`
- `external/pi-tools-suite/test/brainstorm/persistent-workflow.test.ts`

- `external/pi-tools-suite/test/brainstorm/config.test.ts`
- `external/pi-tools-suite/test/brainstorm/extension.test.ts`
- `external/pi-tools-suite/test/brainstorm/run-models.test.ts`
- `external/pi-tools-suite/test/brainstorm/subagents.test.ts`
- `external/pi-tools-suite/test/brainstorm/research-extension.test.ts`
- `external/pi-tools-suite/test/brainstorm/workflow.test.ts`
- `external/pi-tools-suite/test/brainstorm/continuation.test.ts`
- `external/pi-tools-suite/test/brainstorm/audit.test.ts`
- `external/pi-tools-suite/test/brainstorm/v4-behavior.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`
- `tests/pi-tools-suite-schema.test.ts`

## Verification

Run suite typecheck, focused `bun test test/brainstorm test/config.test.ts
test/evals/extension-contracts.test.ts test/evals/harness.test.ts`, schema generation
and sync checks. Deterministic adapters test exact models/read-only tools,
cancellation and failure handling; workflow tests cover five-round ordering,
provenance, retained drafts, cumulative limits, incomplete state, path confinement,
review/finalization races and the review prerequisite. Isolated SDK inventory tests
cover actual extension loading with/without an index and safe tool selection,
while guard tests reject late mutation/recursive calls. No live
council, comparative quality benchmark or real TUI/Desktop interaction is implied
by these tests. Audit tests check mode-specific prompts/reports, persisted mode,
v2/v3→v4 migration and invalid-mode rejection; v4 tests cover quorum gaps,
ledger history/matrix, response hashes, script warnings, thinking overrides,
outputDir confinement, publish and roster derivation; command tests verify option parsing
and routing instructions, not actual parent selection quality. No dedicated live
audit/routing eval has been run. Sync the source to the installed suite and reload/restart the host
to expose the new command/tool.
