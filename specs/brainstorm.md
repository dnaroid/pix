---
kind: spec
status: active
---

# Multi-model brainstorm and audit council (skill)

The council is the `brainstorm` **skill**, not a tool. It runs five paid
read-only rounds with 2–6 exact models. Each model is one persistent `research`
sub-agent of the ordinary async-subagents tool. The parent agent does the
routing, writes the brief and the synthesis, and makes the sub-agent calls.
A deterministic helper (`scripts/council.mjs`) owns the roster, the manifest,
hashes, quorum, round files, ledgers and confined storage. See
[0071](../docs/decisions/0071-brainstorm-skill-on-subagents.md).

## Shipping and entry points

- `external/pi-tools-suite/src/brainstorm/index.ts` returns the skill file from
  `resources_discover` (`skillPaths`). It also keeps `/brainstorm <args>` as a
  shortcut that sends `/skill:brainstorm <args>` with prompt-template expansion.
  Empty args only show usage. `modules.brainstorm: false` removes both.
- `SKILL.md` sets `disable-model-invocation: true`, so the skill is not listed
  in the system prompt's available skills of every project; it runs only via
  `/brainstorm` or an explicit `/skill:brainstorm` (SDK expansion ignores the
  flag). Natural-language requests without the command do not auto-load it.
- The skill lives in `src/brainstorm/skill/`: `SKILL.md` (the parent workflow),
  `prompts.md` (participant templates), `council-guard.ts` (participant tool
  guard), `scripts/council.mjs` and `scripts/lib/*.mjs` (helper; Node only,
  no suite imports).
- There is no `brainstorm` tool, no ACP council host and no Desktop council
  HUD, banner or participant tabs. Participants appear like any other sub-agent:
  in the Subagents status popup, with read-only session viewer tabs
  ([desktop session sidebar](desktop-session-sidebar.md)).

## Parent workflow (SKILL.md)

1. **Inputs.** `[--mode auto|brainstorm|audit] [--models provider/model:effort,...] <topic>`.
   `--models` is a run-only override that the user selected. The parent never
   picks a cheaper or different roster and never substitutes a model.
2. **Mode.** Resolved before paid work from the intended outcome: create or
   explore alternatives → `brainstorm`; evaluate an existing artifact →
   `audit`. Mixed or unclear requests get one targeted question. An explicit
   mode wins unless it conflicts with the outcome; the mode is fixed per run.
3. **Brief** (≤12,000 chars): Goal, Constraints, Non-goals, Success criteria,
   Known evidence, labeled Assumptions/open questions, Fixed decisions. Audits
   also name the target material and version, author intent, criteria and
   scope. Missing material is requested, never invented.
4. **Rounds 1–4.** `init` returns a `spawn` action and a `wait` action, which
   the parent passes to `subagents` unchanged. After `wait`, the parent runs
   `collect`. It returns `pending` (exit 3), `running` with one `send` per active
   participant, or `awaiting_synthesis`. The parent never relays participant
   text itself; prompts and answers move through files.
5. **Round 5.** The parent writes a draft (≤40,000 chars). `review` stores
   `draft-proposal.md` with its SHA-256 and returns the review sends.
   `collect` then reaches `awaiting_finalization`.
6. **Finalize.** `finalize` writes `revision-notes.md` and replaces the pending
   `proposal.md`. With `--publish` it also copies the proposal only to
   `docs/brainstorms/<run>.md`. Implementation never starts from a council.

Brainstorm rounds: ideas, combinations, critique, revision, synthesis review.
Audit rounds: findings, cross-check and coverage, critique of findings,
priorities and minimal fixes, report review. Audit report rules (evidence,
severity separate from confidence, no redesign by default) are in SKILL.md §7.

## Helper contract (`council.mjs`)

Commands: `init`, `collect [--missing p2=reason,...]`, `review`, `finalize`,
`status`, `abort`. Inputs come from `--*-file` (or `-` for stdin). Output is one
JSON object. Exit codes: `0` ok, `3` pending, `2` usage or validation error with
the run state untouched, `1` run marked incomplete.

- **Roster.** The helper reads `pi-tools-suite.jsonc` itself, with the same
  layers as the suite loader: `~/.config/pi`, `$PI_CONFIG_DIR`, the nearest
  `.pi/`. Unreadable layers are ignored. `brainstorm.models` (2–6 exact refs) or
  else the enabled `frontierModels` (ordered, deduplicated, max 6), starting
  from the suite's built-in frontier list; `frontierModels: null` restores it. Settings:
  `thinking` (default `high`), `thinkingOverrides` (default
  `zai/glm-5.3: max`), `timeoutSeconds` (default 600), optional `quorum` (default
  max(2, n−1); above the roster size fails), `outputDir` (default
  `.pi/brainstorms`). Parity tests check the frontier roster and the mirrored
  built-in list against `loadPiToolsSuiteConfig` and `DEFAULT_FRONTIER_MODELS`. Run-only `--models` replaces the roster and
  sets each model's effort exactly. The config snapshot is stored for all rounds.
- **Refusals before paid work:** fewer than two models, invalid settings, or a
  force-current-model env var (`ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL`,
  `PI_SUBAGENTS_FORCE_CURRENT_MODEL`, `*_USE_CURRENT_MODEL`).
- **Participants.** Agent `p<slot>` uses `subagentType: research`,
  `promptOverride: "{task}"`, and `extraArgs`
  `--extension <council-guard.ts> --tools read,grep,web_search,web_fetch,project_search`.
  The subagent run dir is `.pi/subagents/<stamp>-brainstorm-<id>`. Before using
  a round, `collect` checks `launch.json` (model, role, extraArgs, thinking), the
  `turn_count` (R−1 before round R), `result.json` (status, exact model) and the
  user-message count in the participant's persisted session (exactly R; live
  follow-ups do not advance `turn_count`). `turn_count` and `result.json` are
  re-read after `result.md`; a changed snapshot stays pending. A missing session
  fails the run. Any mismatch marks the run incomplete. Failed, stopped, timed-out, empty or
  oversized (>40,000 chars) answers, and `--missing`, become declared gaps.
  The participant is dropped from later rounds and never replaced. A round
  below quorum makes the run incomplete.
- **Guard.** `council-guard.ts` re-selects the allowlist plus `todo` and
  `compress` on session start, model select and before each agent start. It
  blocks every other tool call.
- **Storage.** `<outputDir>/<slug>-<id>/`: `manifest.json` (format
  `pi-brainstorm-v5`), `brief.md`, `discussion.md` (position matrix plus all
  rounds), `prompts/round-R-pS.md`, `rounds/round-R-participant-S.md`,
  `draft-proposal.md`, `revision-notes.md`, `proposal.md`. Paths are confined to
  the project; `prompts/` and `rounds/` must not be symlinks. Mutations hold `.council.lock`. Files are
  written exclusively, except for the documented proposal replacement.
  Documents are capped at 200,000 chars. Ledger rows from participants are
  parsed into the position matrix; malformed rows produce script warnings.
- **Recovery.** `collect` (pending) and `status` return `respawn` (round 1) or
  `resend` for participants whose spawn/send never took effect; repeating them
  is safe. A recorded-response hash mismatch is persisted as incomplete by any
  mutating command; `status` still reports it. `abort` marks the run incomplete
  (idempotent for incomplete runs) and returns a `stop` action. Incomplete runs cannot resume. Old `pi-brainstorm-v4` and earlier
  protocols stay readable but cannot continue.

## Tests

`external/pi-tools-suite/test/brainstorm/`:
- `council-config.test.ts`: layering, roster, overrides, parity with the suite loader.
- `council-protocol.test.ts`: five-round flow, gaps and quorum, `--missing`,
  substitution, thinking, extra turn/live follow-up and persisted tamper refusal,
  symlinked subdirectories, respawn/resend recovery, oversize and empty answers,
  init validation, idempotent abort.
- `council-prompts.test.ts`: required templates, unknown placeholders.
- `extension.test.ts`: skill discovery and the `/brainstorm` shortcut.

## Verification

Run `bun test --isolate --timeout 20000 test/brainstorm` and the suite
`tsc -p tsconfig.source.json`. These tests use synthetic sub-agent run
directories; they do not prove live model quality, provider availability or
real five-round cost. A live run is a manual check.
