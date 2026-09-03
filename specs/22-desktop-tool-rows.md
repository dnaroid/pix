# Spec: Desktop tool rows

## Type

Change

## Goal

Render Pix Desktop chat tool rows with the same compact headers and mutation output signals as the TUI.

## Scope

- Carry the programmatic tool name and raw input from ACP into the desktop transcript.
- Display a lowercase, bold tool name followed by compact, normal-weight arguments.
- Use the default TUI color role for each built-in tool family in light and dark themes.
- Keep the existing desktop tool grouping and expandable result bodies.
- Show successful mutation diffs for live and replayed edit/write/apply-patch calls.
- Keep the final tool text after the diff so LSP diagnostics and comment-checker notices appended by pi-tools-suite remain visible.
- Reflect TUI-style post-mutation LSP attention in completed tool status icons and diagnostic line colors.

## Non-goals

- Porting TUI body previews or per-project `toolRenderer` overrides to desktop.
- Synthesizing a clean comment-checker result when the hook emits no notice.
- Producing an `ast_apply` diff when the tool result does not contain enough before/after data; its textual result and LSP diagnostics still render.
- Changing tool grouping or expansion behavior.

## Behavior

- File tools show the path instead of repeating a human title such as `read Read path`.
- Read ranges use the TUI `path:offset+limit` form.
- Shell commands collapse whitespace to one line.
- Search, repository, question, todo, subagent, and unknown tool inputs use compact TUI-style summaries.
- Mutation, search, warning, success, info, accent, muted, and default tool-name roles use the TUI default palette.
- Legacy ACP updates without a programmatic name or raw input fall back to splitting the existing title.
- A completed edit result patch is preferred because it carries full context. Otherwise explicit ACP diff content is used; when both are absent (notably session replay), edit and write diffs are reconstructed from recorded raw input.
- Apply-patch input is rendered as one diff surface for both `*** Begin Patch` and unified-diff forms.
- Failed mutations do not present their requested patch as an applied diff.
- The mutation result text follows the diff and preserves all text blocks in order, including normal success output, `LSP diagnostics:`, and `comment-checker` notices.
- Completed mutation rows with LSP output use an alert icon: error-colored when diagnostics contain an error, otherwise warning-colored, matching the TUI rule.
- LSP headers/alerts, error lines, warning lines, hints, and clean diagnostic lines receive semantic colors; comment-checker headings use the warning role.

## Related files

- `acp/src/acp/event-translator.ts`
- `acp/src/acp/session-replay.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/tool-presentation.ts`
- `desktop/src/lib/tool-output.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/ToolStatusIcon.svelte`
- `desktop/src/styles.css`

## Verification

- ACP tests cover programmatic names for live and replayed tool calls.
- Desktop tests cover transcript preservation, header formatting, legacy fallback, color-role selection, replay diff fallback, patch rendering, LSP attention, and diagnostic line styling.
- `cd acp && npm test && npm run build`
- `cd desktop && npm test && npm run check && npm run build:web`

## Evidence

- Confirmed by code: the TUI renders a lowercase bold name and separately styled header arguments.
- Confirmed by code: the TUI default config assigns colors by tool name and tool family.
- Confirmed by code: pi-tools-suite LSP and comment-checker hooks append text blocks to the final mutation result before `tool_execution_end` is emitted.
- Confirmed by code: the TUI edit/apply-patch renderer places the diff or patch before final result text and changes completed mutation status when LSP output is present.
- Confirmed by tests: ACP retains tool names and final text; desktop presentation matches representative TUI formats and roles.
