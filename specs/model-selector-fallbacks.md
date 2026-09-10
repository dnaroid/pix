# Model selector fallback arrays

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Every persisted or user-facing **singular model selector** has an ordered fallback-model array in the resolved runtime configuration. A selector may legitimately have no fallback candidates, but that state is represented as `[]`, never as an absent/undefined runtime array.

## Scope

- Pix `defaultModel`, `promptEnhancer`, `autocomplete`, and `sessionTitle` selectors.
- Pix Desktop and TUI Git review and commit-message helper selectors.
- pi-tools-suite `lookupModel` and DCP summarizer selectors.
- async-subagent router and legacy singular role selectors, including `modelByParent` entries.
- Config defaults, schemas, loaders/upserts, ACP mirrors, and execution paths that consume the fallback chains.

## Non-goals

- The current interactive session model selected by `/model` or `--model`.
- Explicit one-off sub-agent task model overrides; these intentionally suppress automatic fallback candidates.
- Model pools, scopes, or UI whitelists that are already ordered/set-valued arrays such as agent `models`, preset `models`, `enabledModels`, and Pix `visibleModels`.
- Model-color patterns, model identifiers in telemetry/results, quota keys, or provider payload fields.
- Speech/dictation model assets, which are not LLM model selectors.

## Configuration contract

- A singular selector uses a primary model plus a fallback array. Pix object-shaped selectors use `modelRef` + `fallbackModels`.
- Git helpers keep the existing flat names under the compatibility `desktop.git` namespace: `reviewModelRef` + `reviewFallbackModels`, and `commitMessageModelRef` + `commitMessageFallbackModels`. Both Desktop and TUI consume them.
- pi-tools-suite lookup uses `lookupModel` + `lookupFallbackModels`.
- DCP keeps `summarizerModel` as the ordered primary-model list and `summarizerFallbackModels` as the explicit ordered fallback list. Both are arrays.
- The async-subagent router uses `model` + `fallbackModels`. Agent profiles using the modern `models` field already encode the whole ordered candidate chain in one array. Legacy `model` and each normalized `modelByParent` entry always resolve with `fallbackModels`, defaulting to `[]`.
- Public JSONC schemas keep fallback arrays optional for backward compatibility with existing files. Loaders normalize an omitted fallback field to `[]` whenever the corresponding resolved selector exists.
- Default config files explicitly write fallback arrays so newly created configs document the invariant.
- Save/upsert operations that change a primary selector preserve its existing fallback array, or create `[]` when none exists.

## Execution contract

- Helper workflows that advertise a fallback chain try candidates in order and de-duplicate repeated refs.
- Pix default-model fallbacks apply only to brand-new sessions. An explicit runtime model and a model restored from session history remain strict user/session choices and do not silently fall through to configured defaults.
- A fallback model without an explicit thinking suffix inherits the configured default-model thinking level; an explicit fallback suffix wins.
- Autocomplete, prompt enhancement, Desktop/TUI Git helpers, lookup, session-title generation, DCP summaries, and async-subagent routing use their configured candidate chains rather than storing unused fallback metadata.
- Cancellation/abort remains terminal and must not be converted into a fallback attempt.

## Compatibility

- Existing object or legacy-string configs that omit fallback arrays continue to load. Resolved selectors always expose an array; where no inherited or explicitly configured fallback exists, it is `[]`.
- Existing DCP multi-entry `summarizerModel` configurations remain valid; `summarizerFallbackModels` extends that ordered list.
- Existing async-subagent modern `models` chains retain their meaning and are not rewritten into a primary-plus-fallback object.

## Related files

- `src/config.ts`
- `src/default-pix-config.ts`
- `src/app/runtime.ts`
- `src/app/input/autocomplete-controller.ts`
- `src/app/input/prompt-enhancer-controller.ts`
- `src/app/commands/command-git-actions.ts`
- `src/bundled-extensions/session-title/`
- `acp/src/acp/default-model.ts`
- `acp/src/acp/pix-settings.ts`
- `acp/src/acp/autocomplete.ts`
- `acp/src/acp/prompt-enhancer.ts`
- `acp/src/acp/git-assistant.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `external/pi-tools-suite/src/config.ts`
- `external/pi-tools-suite/src/coding-discipline/index.ts`
- `external/pi-tools-suite/src/dcp/`
- `external/pi-tools-suite/src/async-subagents/core/`
- `src/schemas/pix-schema.ts`
- `src/schemas/pi-tools-suite-schema.ts`

## Verification

- Config tests assert default and legacy selectors resolve with explicit arrays.
- Runtime tests assert default-model candidate ordering and that resumed/explicit models do not gain fallback candidates.
- Helper tests cover fallback execution for lookup and the existing session-title/DCP/sub-agent chains; autocomplete/prompt/Git paths share the same ordered-candidate rule and are exercised by their focused suites, including TUI Git inheritance and explicit fallback clearing.
- Root Pix, ACP, and pi-tools-suite typechecks must pass.
- Generated JSON schemas must be up to date.
