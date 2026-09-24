# Desktop tool rows

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Render Pix Desktop chat tool rows with the same compact headers and mutation output signals as the TUI.

## Scope

- Carry the programmatic tool name and raw input from ACP into the desktop transcript.
- Display a lowercase, bold tool name followed by compact, normal-weight arguments.
- Use semantic operation roles for tool-name colors in light and dark themes, separate from outcome/diagnostic colors.
- Keep expandable tool result bodies while allowing thinking and tool calls to share one Desktop activity group.
- Show successful mutation diffs for live and replayed edit/write/apply-patch calls.
- Keep the final tool text after the diff so LSP diagnostics and comment-checker notices appended by pi-tools-suite remain visible.
- Reflect TUI-style post-mutation LSP attention in completed tool status icons and diagnostic line colors.

## Non-goals

- Porting TUI body previews or per-project `toolRenderer` overrides to desktop.
- Synthesizing a clean comment-checker result when the hook emits no notice.
- Producing an `ast_apply` diff when the tool result does not contain enough before/after data; its textual result and LSP diagnostics still render.
- Changing tool-result content or the explicit expand/collapse affordance.

## Behavior

- File tools show the path instead of repeating a human title such as `read Read path`.
- Reads of `SKILL.md` (direct `read` and the TUI-recognized non-mutating shell reader commands) display as `skill <directory name>` in both child rows and the collapsed group header. Lightweight replay omits `rawInput` until a result is expanded, so direct reads also classify from the tool location or read title at ingestion. Arbitrary shell programs are not classified by inspecting their effects. The skill name is cached during tool ingestion/update so collapsed headers never inspect `rawInput`; active skill calls receive the usual header emphasis, while ordinary reads and shell mutations retain their normal tool name.
- Read ranges use the TUI `path:offset+limit` form.
- Shell commands collapse whitespace to one line.
- Search, repository, question, todo, subagent, and unknown tool inputs use compact TUI-style summaries.
- `repo_context` rows put their query first and show their path prefix before limits. `repo_audit` shows every task-changed path before options; both use the inspect role. Historical `repo_ask` and `repo_knowledge` calls retain their legacy role and argument presentation for replay compatibility.
- Tool names use operation roles (`inspect`, `search`, `mutation`, `execute`, `interact`, `context`, `agent`, `neutral`) rather than outcome roles such as success or warning; subagent calls use a distinct agent color rather than muted text.
- Legacy ACP updates without a programmatic name or raw input fall back to splitting the existing title.
- Consecutive thinking and tool entries share one collapsible activity group until a visible user, assistant, or system message boundary.
- Collapsed activity headers list normalized presentation names plus `thinking` once in first-seen order (for example `thinking, todo, repo_knowledge` even when a name occurs more than once).
- Names with a currently active occurrence are emphasized with the semantic primary color in the activity-group header; completed/inactive header names stay muted. A live thought is active only when it has a recorded start and no recorded end, so replay data without timing metadata is not presented as live.
- Expanding an activity group preserves the original interleaving of thinking blocks and individual tool calls. Child `thinking` rows stay muted even while live; current-activity emphasis is represented once, in the group header, like any other active tool name.
- The group itself does not hydrate tool bodies. Individual result disclosures hydrate on demand; closed groups/results do not mount their expensive Markdown, diffs, or attachment content. Reopening retains individual disclosure state within the same session, while switching sessions resets it even when replay IDs match.
- A completed edit result patch is preferred because it carries full context. Otherwise explicit ACP diff content is used; when both are absent (notably session replay), edit and write diffs are reconstructed from recorded raw input.
- Apply-patch input is rendered as one diff surface for both `*** Begin Patch` and unified-diff forms.
- Failed mutations do not present their requested patch as an applied diff.
- The mutation result text follows the diff and preserves all text blocks in order, including normal success output, `LSP diagnostics:`, and `comment-checker` notices.
- Completed mutation rows with LSP output use an alert icon: error-colored when diagnostics contain an error, otherwise warning-colored, matching the TUI rule.
- Activity-group summaries represent only group lifecycle (pending/running/completed) with neutral pending/completed indicators. They do not inherit failed/success outcome color or LSP warning/error attention from child tool rows; those signals stay on the concrete child call that produced them.
- LSP headers/alerts, error lines, warning lines, hints, and clean diagnostic lines receive semantic colors; comment-checker headings use the warning role.

## Related files

- `acp/src/acp/event-translator.ts`
- `acp/src/acp/session-replay.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/transcript-content.ts`
- `desktop/src/lib/transcript-deferred.ts`
- `desktop/src/lib/transcript-presentation.ts`
- `desktop/src/lib/transcript-reducer.ts`
- `desktop/src/lib/transcript-types.ts`
- `desktop/src/lib/tool-presentation.ts`
- `desktop/src/lib/tool-output.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/TranscriptActivityGroup.svelte`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/app/session-history-concurrency.test.ts`
- `desktop/scripts/transcript-activity-smoke.mjs`
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
