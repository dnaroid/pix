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

Explain selected source code, explain a whole source file inline, translate selected chat text, and translate a whole Markdown document in Preview, without changing the conversation.

## Scope

- In Preview source code, a text selection offers **Explain Code** in the context menu. The assistant explains the selection using up to 15 surrounding source lines (at most 8,000 characters) and the source file path when available. Explanations are capped at 400 output tokens (2–4 sentences or a few bullets) and run without reasoning unless the model ref carries an explicit thinking suffix, so they arrive at autocomplete-like speed.
- A text selection in the chat transcript or in rendered Markdown Preview offers **Translate** and translates the selected text into the configured language (up to 2,048 output tokens).
- Output streams into the popover as it is generated; if a fallback model takes over after a partial failure, the partial text is cleared first.
- The answer appears in a popover near the selection, with Copy and Close actions. Escape and outside click close it.
- A newer request or closing the popover aborts the previous request. Changing workspace closes the popover.
- The private ACP request `pix/selection/assist` accepts `{ cwd, action, text, context?, path?, requestId? }` and returns `{ text }`. Actions are `explain` and `translate`; selected text is limited to 20,000 characters. Model execution has a 30-second timeout. When `requestId` is present, ACP streams `pix/selection/assist_delta` notifications: `{ requestId, text }` appends a chunk and `{ requestId, reset: true }` discards text from a failed fallback candidate.
- Model candidates are tried in order with duplicate refs removed. Cancellation is terminal and does not advance the fallback chain.
- Errors are reported to the diagnostic logger under `frontend:selection-assist:<action>`.

## Inline file explanation

- A Preview source-code file has a header **Explain** toggle. The model reads the file with line numbers and returns a module summary plus notes anchored to lines. The summary ("О модуле" / "About this module") is rendered before line 1; each note is a highlighted insertion row directly above its line (accent border and tinted surface, sans-serif text with inline `code`/bold/emphasis, HTML escaped). Rows have no line number, are not selectable or copied with the source, stay pinned to the left edge while scrolling horizontally, and are not `.sh__line` rows, so numbering, range scrolling and selection context keep counting real source lines.
- There is no separate status strip: while running, the button reads **Explaining…** (clicking it cancels) and a progress row sits before line 1; a failure replaces it with an error row, and clicking **Explain** again retries. Toggling hides or shows the result without a new request; **Shift+click** ignores the cache and explains again. For very large files the summary notes which lines were covered. Editing hides it; failures are logged as `preview:file-annotation-failed`.
- The private ACP request `pix/file/annotate` accepts `{ cwd, text, path?, refresh? }` and returns `{ summary, annotations: [{ line, text }], language, annotatedLines, totalLines, cached }`. The model sees at most the first 3,000 lines / 120,000 characters, may return a summary (up to 1,500 characters) and up to 60 notes (600 characters each), runs with 6,000 output tokens and a 120-second timeout on the selection-assistant model chain, and answers in the configured language. The JSON object may be fenced or wrapped in prose (a bare notes array is also accepted); invalid or out-of-range notes are dropped and notes for the same line are merged. An answer with neither summary nor notes is an error and is not cached.
- Results are cached in `<project>/.pi/explanations/<sha256>.json`, one entry per file path, storing the SHA-256 of the exact source text and the target language. A lookup with different content or language is a miss and deletes the stale entry; the next result replaces it, so any edit to the source invalidates the explanation. Desktop also keeps finished results in memory per path and content for the Preview session (24 entries); changed content never matches. Retention is shared with the translation cache (see below). Cache failures never fail the request and are logged as ACP warnings. Desktop `.pi` Clean preserves this directory.

## Whole-document translation

- Rendered Markdown Preview has a header **Translate** toggle. It replaces the rendered document with its translation into the configured language, streaming progress as sections finish; **Original** switches back without discarding the result, and **Retranslate** repeats it while ignoring cached sections. A status strip shows progress, the language, how many sections came from the cache, and errors. Editing, another document, or changed file content discards the translation; a newer request or closing the Preview aborts the running one. Failures are reported to the diagnostic logger as `preview:document-translation-failed`.
- The private ACP request `pix/document/translate` accepts `{ cwd, text, path?, refresh?, requestId? }` (text up to 400,000 characters) and returns `{ text, language, chunks, cachedChunks }`. Progress reuses `pix/selection/assist_delta` keyed by `requestId`, with `{ reset: true }` restarting the accumulated text when a fallback model replaces a partially streamed section. Delta notifications are sliced to at most 2,000 characters.
- The document is split at blank lines outside fenced code into sections of about 4,000 characters, translated sequentially with the selection-assistant model chain (8,192 output tokens and a 120-second timeout per section). Fenced code blocks and leading front matter pass through verbatim; sections with no translatable text need no model.
- Every translated section is cached in `<project>/.pi/translations/<sha256>.json`, keyed by target language and the exact source section. Any edit to a section changes its key, so a stale translation is never reused (it ages out); unchanged sections of an edited document are reused, and only new or changed sections go to a model. In Desktop, changed Markdown content also discards the displayed translation. Retention: a cache hit refreshes the entry's modification time; entries unused for 30 days are removed and at most 4,000 most recently used entries remain. Pruning runs after a translation, at most once an hour per project, and also removes temporary files older than a day. Cache failures never fail a translation and are logged as ACP warnings. Desktop `.pi` Clean preserves this directory.

## Configuration

Desktop `pix-desktop.jsonc` supports a `selectionAssist` object with `modelRef`, ordered `fallbackModels`, and `language` (default `ru`). If `modelRef` is empty or omitted, the autocomplete model chain is reused. The default Desktop config sets `modelRef` to `zai/glm-5-turbo` and `language` to `ru`.

The model setup wizard provides `selection-assist` (“Explain & translate”, fast role, Assistant group) and `selection-assist-fallback` slots. It writes these selections only when the config already contains a `selectionAssist` object. Settings > Assistant exposes the feature in Feature models and provides an “Explain & translate language” field.

## Related files

- `acp/src/acp/selection-assist.ts`
- `acp/src/acp/assist-model-runner.ts`
- `acp/src/acp/document-translation.ts`
- `acp/src/acp/translation-cache.ts`
- `acp/src/acp/file-annotation.ts`
- `acp/src/acp/project-json-cache.ts`
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
- `desktop/src/components/preview-annotation-controller.svelte.ts`
- `desktop/src/lib/preview-annotations.ts`
- `desktop/src/lib/syntax-highlight.ts`
- `desktop/src/styles.css`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src-tauri/src/lib.rs` (`.pi/translations` and `.pi/explanations` are canonical)
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`

## Tests

- `acp/test/selection-assist.test.ts`
- `acp/test/document-translation.test.ts`
- `acp/test/file-annotation.test.ts`
- `desktop/src/lib/selection-assist.test.ts`
- `desktop/src/components/preview-translation-controller.test.ts`
- `desktop/src/components/preview-annotation-controller.test.ts`
- `desktop/src/lib/preview-annotations.test.ts`
- `desktop/src/lib/syntax-highlight.test.ts`
- `desktop/src-tauri/src/lib.rs` (`project_pi_cleanup_preserves_translation_and_explanation_caches`)

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"15b9c9f1443bf948539685892ac4de6629de3ab54b16070445d8dfaa3bd8a8e5","checkedAt":"2026-10-31T00:41:49.787Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":68,"reportLanguage":"ru"} -->
