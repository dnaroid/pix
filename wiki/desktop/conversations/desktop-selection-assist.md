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

Explain selected source code and translate selected chat text without changing the conversation.

## Scope

- In Preview source code, a text selection offers **Explain Code** in the context menu. The assistant explains the selection using up to 15 surrounding source lines (at most 8,000 characters) and the source file path when available. Explanations are capped at 400 output tokens (2–4 sentences or a few bullets) and run without reasoning unless the model ref carries an explicit thinking suffix, so they arrive at autocomplete-like speed.
- A text selection in the chat transcript or in rendered Markdown Preview offers **Translate** and translates the selected text into the configured language (up to 2,048 output tokens).
- Output streams into the popover as it is generated; if a fallback model takes over after a partial failure, the partial text is cleared first.
- The answer appears in a popover near the selection, with Copy and Close actions. Escape and outside click close it.
- A newer request or closing the popover aborts the previous request. Changing workspace closes the popover.
- The private ACP request `pix/selection/assist` accepts `{ cwd, action, text, context?, path?, requestId? }` and returns `{ text }`. Actions are `explain` and `translate`; selected text is limited to 20,000 characters. Model execution has a 30-second timeout. When `requestId` is present, ACP streams `pix/selection/assist_delta` notifications: `{ requestId, text }` appends a chunk and `{ requestId, reset: true }` discards text from a failed fallback candidate.
- Model candidates are tried in order with duplicate refs removed. Cancellation is terminal and does not advance the fallback chain.
- Errors are reported to the diagnostic logger under `frontend:selection-assist:<action>`.

## Configuration

Desktop `pix-desktop.jsonc` supports a `selectionAssist` object with `modelRef`, ordered `fallbackModels`, and `language` (default `ru`). If `modelRef` is empty or omitted, the autocomplete model chain is reused. The default Desktop config sets `modelRef` to `zai/glm-5-turbo` and `language` to `ru`.

The model setup wizard provides `selection-assist` (“Explain & translate”, fast role, Assistant group) and `selection-assist-fallback` slots. It writes these selections only when the config already contains a `selectionAssist` object. Settings > Assistant exposes the feature in Feature models and provides an “Explain & translate language” field.

## Related files

- `acp/src/acp/selection-assist.ts`
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
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`

## Tests

- `acp/test/selection-assist.test.ts`
- `desktop/src/lib/selection-assist.test.ts`
