# Desktop Question Tool

## Type

Change

## Goal

Render the bundled `question` tool as an inline mode of the existing Pix Desktop prompt composer while preserving the structured answers and cancellation behavior used by the TUI.

## Scope

- Load Pix's bundled question extension in Desktop-owned Pi RPC sessions.
- Bridge a validated private question payload through Pi RPC and ACP.
- Present one to five single- or multi-select questions, predefined choices, custom text, and custom image attachments inside the bottom composer while leaving the transcript visible.
- Support direct question tabs, a permanent final Preview tab, edit, submit, cancel, and safe cancellation during reconnect or shutdown.
- Keep existing TUI behavior and ordinary ACP form elicitations unchanged.

## Non-goals

- Expose the private `_pix.question` mode as a general ACP standard.
- Allow zero-answer questions or more than one custom answer per question.
- Change the serialized shape of existing single-select answers.

## Behavior

1. When an agent invokes `question`, the normal bottom composer switches in place to questionnaire mode; no overlay is opened and the transcript remains usable.
2. Tabs above the composer content represent each question and a final Preview. Completed question tabs carry a completion mark and every tab remains directly selectable for editing.
3. A question tab shows its prompt and predefined choices. Single-select questions use radio controls. Questions with `multiple: true` use checkboxes and may combine predefined choices with `Something else…`; selecting the latter activates the composer's textarea plus its image choose/paste/remove/preview interactions.
4. A multi-select question defaults to at least one and at most every available answer, including the implicit custom answer. Optional `minSelections` and `maxSelections` constrain that count. An enabled custom answer counts as one selection and is complete only when it has non-empty text and/or images.
5. Preview lists every answer, highlights missing answers, and links back to each question. `Submit answers` is available only there and is disabled until all questions are complete.
6. Cancel returns a user-canceled tool result; reconnect, shutdown, malformed payloads, and unsupported responses also cancel rather than inventing an answer. Normal chat submission is unavailable in questionnaire mode.
7. Custom images are previewed locally and returned as Pi image content. Desktop limits a questionnaire to 10 images, 25 MB per image, and 50 MB total.

## Contracts

- The bundled extension uses `ctx.ui.editor` only when `PIX_QUESTION_RPC_BRIDGE=1`; otherwise it retains the existing TUI `ctx.ui.custom` path.
- The private editor carrier has a reserved versioned title and JSON prefill. ACP validates it before emitting an implementation-specific `_pix.question` elicitation.
- Desktop accepts only version 1 normalized question payloads: 1–5 unique question ids, 2–5 unique choice values per question, and non-empty labels/prompts/values.
- `multiple` defaults to `false`. `minSelections` and `maxSelections` are valid only for multi-select questions, must be integers, and must satisfy `1 <= minSelections <= maxSelections <= choices.length + 1`; omitted bounds normalize to `1` and `choices.length + 1`.
- Desktop returns versioned JSON in ACP accept content key `value`; the extension validates question ids, unique choice values, selection bounds, custom text, image MIME types, and base64 data before creating the authoritative result shape.
- Existing single-select results retain their current scalar answer shape. Multi-select results contain one answer per question with `multiple: true` and an ordered `selections` array; each item uses the existing choice/custom answer fields.
- Only Desktop-launched ACP sessions receive the explicit bundled extension path and bridge environment flag. Other ACP clients retain existing behavior.

## Verification

- Root tests cover schema normalization, limits, additive custom answers, carrier validation, result compatibility, cancellation, and TUI interaction.
- ACP tests cover multi-select carrier mapping, malformed bound rejection, response mapping, and explicit Pi extension arguments.
- Desktop tests cover request parsing, single/multi selection state, limits, additive custom answers, serialization, and tab/Preview navigation.
- Run root question tests and typecheck, ACP tests/check, and Desktop tests/check/build:web.

## Related files

- `src/bundled-extensions/question/{contract,types,result,tui,desktop}.ts`
- `acp/src/acp/ui-request-bridge.ts`
- `desktop/src/lib/question.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/App.svelte`

## Evidence

- Confirmed by code: normalized question bounds, grouped response validation, TUI selection state, ACP carrier validation, and Desktop composer state.
- Confirmed by tests: root contract/result/TUI/renderer tests, ACP bridge tests, and Desktop question state tests.
