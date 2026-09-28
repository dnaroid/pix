# Parent-first sub-agent role selection

## Type

Change

## Lifecycle

Active implemented contract.

> Test paths mentioned below are relative to `external/pi-tools-suite/`.

## Goal

Use the effective role catalog introduced in spec 28 for direct parent choices.
Keep the LLM router as a fallback for omitted types, not a mandatory extra call.
This delta supersedes the old silent `defaultType` fallback at the spawn boundary.

## Contract

1. Parent prompts and both task schemas share one selection guideline: set a
   clearly matching role, prefer a matching project specialist, and preserve a
   user-requested role. Omission is allowed for uncertainty or a user request for
   automatic routing. Before prompt/routing, parent-model gates and project
   capability gates remove unavailable roles. `requiresIndexedProject: true`
   requires `.indexer-cli/` at the resolved project root. Real UI QA requires
   the explicit built-in `ui-qa` role; there is no `browser-qa` alias.
   The parent catalog also names active project-local replacements of bundled
   roles. A same-named project role is the complete effective profile; the
   parent must not assume omitted built-in tools, gates, models, or instructions.
2. Explicit names are validated against the effective config before any router
   request. Unknown names are errors, not unconfigured/ad-hoc agent profiles.
   Valid names bypass routing and its provider/auth calls, even when disabled.
3. Only tasks with omitted types are sent to the fallback router. A complete
   valid routing response is required; explicit choices are never overwritten.
4. Provider error responses, thrown requests, empty/invalid responses, and
   incomplete routes can advance to a configured fallback router. Exhausting
   candidates raises `SubagentRoutingError`, including affected IDs and allowed
   types. Cancellation propagates rather than trying another model.
5. `spawn` converts routing errors into a visible tool error and launches none
   of the batch, including explicitly typed tasks. No new run directory,
   registry entry, prompt files, or child processes are created. Correct the
   role choices and resubmit the entire batch without duplicating workers.
6. With routing disabled, omissions are errors even when `defaultType` is set.
   `defaultType` remains an ambiguity hint to a working router and a legacy
   lower-level resolver default; it is not a spawn failure fallback.
7. Outside mandatory `ui-qa`, delegation is parent-first. The parent does the
   shortest discovery pass needed to resolve user intent, semantics, and the
   main causal path. If targeted repository/context search or a few reads already
   establish the diagnosis and desired behavior, the parent continues directly
   instead of spawning research that repeats the same investigation. Delegated
   research answers a named uncertainty, independent hypothesis, or noisy
   evidence question. An explicit user request to delegate/parallelize/split work
   remains a delegation trigger after this minimal scoping pass.
8. `implement` delegation starts only after the parent has settled the cause,
   desired behavior, and acceptance criteria. The task should be the smallest
   coherent substantial slice that benefits from isolation or a lower-cost
   worker; broad speculative cross-layer edits are not the default. Planning,
   product/UX decisions, integration, and the final answer remain parent-owned.
9. Spawn is not a reason to idle the parent. After spawning, the parent continues
   independent work and does not poll or wait merely for progress. Waiting is
   appropriate only when the child result is a true dependency for the next
   decision and no independent parent work remains. If requirements change, the
   affected worker is stopped or rescoped before it continues editing.
10. When `knowledge-auditor` is present in the effective catalog, the parent
    delegates the final task-scoped repository-knowledge pass to it with a
    concise behavior/result summary and the exact project-relative task-changed
    paths. The auditor may repair only small confirmed documentation drift;
    substantial or ambiguous drift returns to the parent for a decision.

## Unchanged behavior

Markdown definitions, config precedence, role-owned model candidates,
model/thinking overrides,
spawn concurrency, and child model fallbacks remain unchanged. Every child is
started with `--no-skills`; any `--skill <path>`, `--skill=<path>`, or
caller-supplied `--no-skills` arguments are stripped before invocation, so no
child role (including `ui-qa`) discovers or receives skills. This is role
selection, not model routing.

## Verification

- `test/async-subagents/routing.test.ts`: explicit bypass and validation,
  omitted/mixed tasks, disabled/unavailable routing, invalid/partial responses,
  provider errors, fallback models, cancellation, and project Markdown roles.
- `test/async-subagents/tools.test.ts`: public and internal spawn errors are
  visible and create no run state; explicit spawns still apply their profiles
  with the router disabled.
- `test/tool-descriptions.test.ts`: parent catalog and tool guidance agree.
- Opt-in live selection evals verify the parent-first boundary in both
  directions: a targeted root-cause investigation and a compact already-specified
  implementation stay in the parent without a `subagents` call, while an
  explicit delegation request still produces one role-appropriate spawn without
  model/thinking overrides or progress polling. They also distinguish normal
  explicit parent selection from explicitly requested automatic routing. Direct
  live evals additionally exercise a project-local Markdown specialist alongside
  built-in roles.

Live semantic results must be reported separately from deterministic tests.
