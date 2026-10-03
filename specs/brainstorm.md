---
kind: spec
status: active
---

# Configured multi-model brainstorm and audit council

## Behavior

The shared pi-tools-suite `brainstorm` module replaces the local brainstorm skill.
`/brainstorm [--mode auto|brainstorm|audit] <topic and constraints>` queues a parent request to the model-only
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
no classifier model call. Only the leading flag is parsed (space or `=` form);
invalid/duplicate leading options and empty topics queue no request.

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

`brainstorm(action="run", mode="brainstorm"|"audit", topic, brief)` runs the first four rounds using the exact
ordered `brainstorm.models` roster from pi-tools-suite.jsonc:

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

All rounds use fresh participants with stable model/slot identities. Rounds 2–5
receive the complete prior round responses, not sibling answers from the current
round. The parent reads the saved brief/discussion and submits a draft through
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
`docs/brainstorms/<date>-<topic-slug>-<random-id>/` containing `brief.md`,
`discussion.md`, `proposal.md` and `manifest.json`. Review adds `draft-proposal.md`;
finalization adds `revision-notes.md`. Discussion records each response under its
round, participant ID and model; adapter responses link raw source artifacts.
This is a protocol of emitted answers and decisions, not hidden model reasoning.
The proposal starts explicitly pending synthesis. Successful rounds 1–4 leave
`awaiting_synthesis`; review moves through `reviewing_synthesis` to
`awaiting_finalization`; successful parent finalization leaves `complete`.
Manifest v3 stores resolved mode, brief, config snapshot, completed responses and draft SHA-256.
Raw child artifacts remain under `.pi/subagents/`. Legacy v1 artifacts remain
readable as documents but cannot continue under the new protocol; start a new run.
Original v2 five-round manifests without a mode may continue as `brainstorm`;
successful continuation writes v3. A mode-tagged v2 or a missing/invalid v3 mode
is rejected before council work/document mutation (apart from the transient lock).
Both modes retain the same directory and filenames: `proposal.md` is the final
audit report in audit mode; `draft-proposal.md` is its preserved draft.

## Configuration

The usual suite user/environment/project layering applies. `brainstorm.models`
replaces the inherited list, independently of `frontierModels`. It accepts 2–6
distinct exact `provider/model` references, not wildcards. Initial explicit defaults:

- `openai-codex/gpt-6-astra`
- `zai/glm-5.3`
- `anthropic/claude-opus-5-5`
- `antigravity/antigravity-gemini-3.8-flash`

`brainstorm.thinking` defaults to `high`; `brainstorm.timeoutSeconds` defaults to
600 per participant per round, with integer bounds 30–1800. Invalid settings
raise configuration errors, not silent roster substitution. Disable the module
through `modules.brainstorm: false` or the ordinary module disable mechanisms.

## Constraints and failure cases

- All five rounds use the existing `subagents` tool through SDK nested execution:
  hooks, permissions, usage attribution, availability/auth checks, retries,
  project concurrency and owned process lifecycle remain authoritative. The
  async-subagents tool and `research` role must be available. Explicit models
  have no fallback candidates; economy and role policies can reject them.
- Forced-current-model environment overrides and nonempty `research.extraArgs`
  are rejected, since they could defeat the exact roster or read-only tool set.
  Participants receive canonical `read`/`grep`, `web_search`/`web_fetch` and the
  eight read-only `repo_*` discovery tools (context, audit, architecture,
  structure, ast, search, explain, deps). A dedicated explicit child extension
  loads only web/repo capabilities; the full suite remains disabled. Its final
  CLI allowlist preserves custom names and avoids model aliasing of grep into
  shell. Lifecycle selection and a tool-call guard prohibit shell, mutation,
  recursive council/subagent tools and provider-native web search.
  Setup/update/credential commands are not registered in council children.
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
- Five rounds cost five times the roster size in ordinary child runs (20 with
  four models), plus configured retries and parent drafting/revision. Settings
  changed after `run` do not change the stored roster/thinking/timeouts for review;
  current availability/auth and subagent policies still apply. No paid model call occurs merely
  from module registration. Round deadlines include bounded queue time.
- Cancellation, timeout, failed participants, absent/duplicate responses,
  substituted models, truncated/empty/oversize output prevent synthesis. The
  adapter requests ownership-aware cancellation for the exact round; owned
  teardown may drain asynchronously. Completed earlier rounds and raw artifacts
  are retained, and the document manifest is marked incomplete when writable.
- Review and finalization accept only generated runs under the current project's
  document root, reject symlink escapes and share an exclusive lock. State is
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

- `external/pi-tools-suite/src/brainstorm/config.ts`
- `external/pi-tools-suite/src/brainstorm/index.ts`
- `external/pi-tools-suite/src/brainstorm/subagents.ts`
- `external/pi-tools-suite/src/brainstorm/research-tools.ts`
- `external/pi-tools-suite/src/brainstorm/research-extension.ts`
- `external/pi-tools-suite/src/brainstorm/workflow.ts`
- `external/pi-tools-suite/src/brainstorm/continuation.ts`
- `external/pi-tools-suite/src/brainstorm/prompts.ts`
- `external/pi-tools-suite/src/brainstorm/modes.ts`
- `external/pi-tools-suite/src/brainstorm/instructions.ts`
- `external/pi-tools-suite/src/brainstorm/storage.ts`
- `external/pi-tools-suite/src/config.ts`
- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/prompt-commands/index.ts`
- `src/schemas/pi-tools-suite-schema.ts`
- `schemas/pi-tools-suite.json`

## Tests

- `external/pi-tools-suite/test/brainstorm/config.test.ts`
- `external/pi-tools-suite/test/brainstorm/extension.test.ts`
- `external/pi-tools-suite/test/brainstorm/subagents.test.ts`
- `external/pi-tools-suite/test/brainstorm/research-extension.test.ts`
- `external/pi-tools-suite/test/brainstorm/workflow.test.ts`
- `external/pi-tools-suite/test/brainstorm/continuation.test.ts`
- `external/pi-tools-suite/test/brainstorm/audit.test.ts`
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
v2 compatibility and invalid-mode rejection; command tests verify option parsing
and routing instructions, not actual parent selection quality. No dedicated live
audit/routing eval has been run. Sync the source to the installed suite and reload/restart the host
to expose the new command/tool.
