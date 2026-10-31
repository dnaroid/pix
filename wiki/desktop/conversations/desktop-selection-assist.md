---
kind: spec
status: active
---

# Desktop selection assistant

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Explain selected source code or a whole source file, translate selected chat text, and translate a whole Markdown document in Preview, without changing the conversation.

## Scope

- In Preview source code, a text selection offers **Explain Code** in the context menu. The assistant explains the selection using up to 15 surrounding source lines (at most 8,000 characters) and the source file path when available. Explanations are capped at 400 output tokens (2–4 sentences or a few bullets) and run without reasoning unless the model ref carries an explicit thinking suffix, so they arrive at autocomplete-like speed.
- In a Preview source-code file, the header **Explain** button explains the whole file (action `explain-file`): purpose, main parts in source order and non-obvious details, capped at 1,500 output tokens with a 60-second timeout. Files longer than 120,000 characters are explained from their beginning with a truncation note. The answer uses the same popover, widened for a longer read; pressing the button again for the same file closes it.
- A text selection in the chat transcript or in rendered Markdown Preview offers **Translate** and translates the selected text into the configured language (up to 2,048 output tokens).
- Output streams into the popover as it is generated; if a fallback model takes over after a partial failure, the partial text is cleared first.
- The answer appears in a popover near the selection, with Copy and Close actions. Escape and outside click close it.
- A newer request or closing the popover aborts the previous request. Changing workspace closes the popover.
- The private ACP request `pix/selection/assist` accepts `{ cwd, action, text, context?, path?, requestId? }` and returns `{ text }`. Actions are `explain`, `explain-file` and `translate`; selected text is limited to 20,000 characters (120,000 for `explain-file`). Model execution has a 30-second timeout. When `requestId` is present, ACP streams `pix/selection/assist_delta` notifications: `{ requestId, text }` appends a chunk and `{ requestId, reset: true }` discards text from a failed fallback candidate.
- Model candidates are tried in order with duplicate refs removed. Cancellation is terminal and does not advance the fallback chain.
- Errors are reported to the diagnostic logger under `frontend:selection-assist:<action>`.

## Whole-document translation

- Rendered Markdown Preview has a header **Translate** toggle. It replaces the rendered document with its translation into the configured language, streaming progress as sections finish; **Original** switches back without discarding the result, and **Retranslate** repeats it while ignoring cached sections. A status strip shows progress, the language, how many sections came from the cache, and errors. Editing, another document, or changed file content discards the translation; a newer request or closing the Preview aborts the running one. Failures are reported to the diagnostic logger as `preview:document-translation-failed`.
- The private ACP request `pix/document/translate` accepts `{ cwd, text, path?, refresh?, requestId? }` (text up to 400,000 characters) and returns `{ text, language, chunks, cachedChunks }`. Progress reuses `pix/selection/assist_delta` keyed by `requestId`, with `{ reset: true }` restarting the accumulated text when a fallback model replaces a partially streamed section. Delta notifications are sliced to at most 2,000 characters.
- The document is split at blank lines outside fenced code into sections of about 4,000 characters, translated sequentially with the selection-assistant model chain (8,192 output tokens and a 120-second timeout per section). Fenced code blocks and leading front matter pass through verbatim; sections with no translatable text need no model.
- Every translated section is cached in `<project>/.pi/translations/<sha256>.json`, keyed by target language and the exact source section, so reopening or re-translating an edited document only sends new or changed sections to a model. Retention: a cache hit refreshes the entry's modification time; entries unused for 30 days are removed and at most 4,000 most recently used entries remain. Pruning runs after a translation, at most once an hour per project, and also removes temporary files older than a day. Cache failures never fail a translation and are logged as ACP warnings. Desktop `.pi` Clean preserves this directory.

## Configuration

Desktop `pix-desktop.jsonc` supports a `selectionAssist` object with `modelRef`, ordered `fallbackModels`, and `language` (default `ru`). If `modelRef` is empty or omitted, the autocomplete model chain is reused. The default Desktop config sets `modelRef` to `zai/glm-5-turbo` and `language` to `ru`.

The model setup wizard provides `selection-assist` (“Explain & translate”, fast role, Assistant group) and `selection-assist-fallback` slots. It writes these selections only when the config already contains a `selectionAssist` object. Settings > Assistant exposes the feature in Feature models and provides an “Explain & translate language” field.

## Related files

- `acp/src/acp/selection-assist.ts`
- `acp/src/acp/assist-model-runner.ts`
- `acp/src/acp/document-translation.ts`
- `acp/src/acp/translation-cache.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/model-setup.ts`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `desktop/src/lib/default-desktop-config.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/selection-assist-target.ts`
- `desktop/src/app/selection-assist.svelte.ts`
- `desktop/src/components/SelectionAssistPopover.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/preview-translation-controller.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src-tauri/src/lib.rs` (`.pi/translations` is canonical)
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`

## Tests

- `acp/test/selection-assist.test.ts`
- `acp/test/document-translation.test.ts`
- `desktop/src/lib/selection-assist.test.ts`
- `desktop/src/components/preview-translation-controller.test.ts`
- `desktop/src-tauri/src/lib.rs` (`project_pi_cleanup_preserves_translation_cache`)

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"15b9c9f1443bf948539685892ac4de6629de3ab54b16070445d8dfaa3bd8a8e5","checkedAt":"2026-10-31T00:41:49.787Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":68,"reportLanguage":"ru"} -->
