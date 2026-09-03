# Spec: Desktop tool rows

## Type

Change

## Goal

Render Pix Desktop chat tool headers with the same name, compact arguments, and default name colors as the TUI.

## Scope

- Carry the programmatic tool name and raw input from ACP into the desktop transcript.
- Display a lowercase, bold tool name followed by compact, normal-weight arguments.
- Use the default TUI color role for each built-in tool family in light and dark themes.
- Keep the existing desktop tool grouping and expandable result bodies.

## Non-goals

- Porting TUI body previews or per-project `toolRenderer` overrides to desktop.
- Changing tool status icons, grouping, result rendering, or expansion behavior.

## Behavior

- File tools show the path instead of repeating a human title such as `read Read path`.
- Read ranges use the TUI `path:offset+limit` form.
- Shell commands collapse whitespace to one line.
- Search, repository, question, todo, subagent, and unknown tool inputs use compact TUI-style summaries.
- Mutation, search, warning, success, info, accent, muted, and default tool-name roles use the TUI default palette.
- Legacy ACP updates without a programmatic name or raw input fall back to splitting the existing title.

## Related files

- `acp/src/acp/event-translator.ts`
- `acp/src/acp/session-replay.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/tool-presentation.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/styles.css`

## Verification

- ACP tests cover programmatic names for live and replayed tool calls.
- Desktop tests cover transcript preservation, header formatting, legacy fallback, and color-role selection.
- `cd acp && npm test && npm run build`
- `cd desktop && npm test && npm run check && npm run build:web`

## Evidence

- Confirmed by code: the TUI renders a lowercase bold name and separately styled header arguments.
- Confirmed by code: the TUI default config assigns colors by tool name and tool family.
- Confirmed by tests: ACP retains tool names and desktop presentation matches representative TUI formats and roles.
