# Parent-first sub-agent role selection

## Goal

Use the effective role catalog introduced in spec 28 for direct parent choices.
Keep the LLM router as a fallback for omitted types, not a mandatory extra call.
This delta supersedes the old silent `defaultType` fallback at the spawn boundary.

## Contract

1. Parent prompts and both task schemas share one selection guideline: set a
   clearly matching role, prefer a matching project specialist, and preserve a
   user-requested role. Omission is allowed for uncertainty or a user request for
   automatic routing. Before prompt/routing, `forParentModels` /
   `notForParentModels` gates remove roles that are unavailable to the current
   parent model. Browser QA retains its explicit `browser-qa` requirement.
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

## Unchanged behavior

Markdown definitions, config precedence, presets, model/thinking overrides,
mandatory private browser QA skills, spawn concurrency, and child model
fallbacks remain unchanged. This is role selection, not model routing.

## Verification

- `test/async-subagents/routing.test.ts`: explicit bypass and validation,
  omitted/mixed tasks, disabled/unavailable routing, invalid/partial responses,
  provider errors, fallback models, cancellation, and project Markdown roles.
- `test/async-subagents/tools.test.ts`: public and internal spawn errors are
  visible and create no run state; explicit spawns still apply their profiles
  with the router disabled.
- `test/tool-descriptions.test.ts`: parent catalog and tool guidance agree.
- Opt-in live selection evals distinguish normal explicit parent selection
  from explicitly requested automatic routing. Direct live evals additionally
  exercise a project-local Markdown specialist alongside built-in roles.

Live semantic results must be reported separately from deterministic tests.
