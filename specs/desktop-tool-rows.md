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
- Changing tool-result content or the per-tool result disclosure affordance. The activity group's gutter collapse control is specified separately in `specs/desktop-activity-row-timing.md`.

## Behavior

- File tools show the path instead of repeating a human title such as `read Read path`.
- Reads of `SKILL.md` (direct `read` and the TUI-recognized non-mutating shell reader commands) display as `skill <directory name>` in both child rows and the collapsed group header. Lightweight replay omits `rawInput` until a result is expanded, so direct reads also classify from the tool location or read title at ingestion. Arbitrary shell programs are not classified by inspecting their effects. The skill name is cached during tool ingestion/update so collapsed headers never inspect `rawInput`; collapsed group list names always keep their native semantic tool tones regardless of liveness, while ordinary reads and shell mutations retain their normal tool name.
- Read ranges use the TUI `path:offset+limit` form.
- Expanded source reads use theme-aware syntax highlighting by file extension, including `.gd` GDScript (keywords, types, strings and hash comments). Legacy read titles with range suffixes also resolve their source language. Unknown languages and oversized sources retain escaped, untruncated plaintext; directory listings remain plain.
- Shell commands collapse whitespace to one line.
- Expanded `codemode`, shell/execution aliases, `repo_*`, `ast_grep`, `ast_apply`, `subagents`, `brainstorm`, `web_search`, and `question` rows show full raw input in an explicitly labeled Input block before Result. Fields and nested tasks/questions are readable without JSON string escaping; multiline strings remain intact. No separate input block is added for `apply_patch`, reads, web fetches, planning or session tools. Existing patch presentation remains unchanged.
- Selected calls with input but no result can still expand. Input formatting is deferred until the individual disclosure mounts; lightweight replay continues hydrating input/result only on demand.
- Expanded executable inputs use the shared theme-aware syntax highlighter: JavaScript for `codemode`, shell syntax for shell/execution aliases. Other tool inputs remain plain text. Input keeps soft wrapping and all supplied fields; the shared large-source safeguard falls back to escaped plaintext without truncation.
- Expanded text input/result panels grow to at most `min(480px, 60vh)` rather than 220px. They contain scroll chaining at both boundaries, so wheel/trackpad scrolling inside a panel does not move the surrounding chat at its start/end. Outside the panels chat scrolling remains normal.
- Each expanded tool body has its own keyboard-accessible gutter button. Clicking it closes only that tool disclosure, unmounts its body and restores focus to its summary; the enclosing activity group and sibling disclosures stay open.
- Search, repository, question, todo, subagent, and unknown tool inputs use compact TUI-style summaries.
- The single `session` tool uses the subdued context tone. At ingestion, exact `action` values cache safe activity labels: `name` distinguishes title reads from renames, `search` searches session history, and `overview`/`read`/`recovery` review it. Missing/unknown action falls back to `Reviewing session`; rendering never reads raw payloads to choose a label. Old session tool names have no special presentation mapping.
- `repo_context` rows put their query first and show their path prefix before limits; their discovery role is search. `repo_audit` shows every task-changed path before options and uses inspect. Historical `repo_ask` and `repo_knowledge` calls retain their legacy argument presentation for replay compatibility.
- Tool names use operation roles (`inspect`, `search`, `mutation`, `execute`, `interact`, `context`, `agent`, `skill`, `compress`, `neutral`) rather than outcome roles such as success or warning: reads/audits are teal inspection, discovery/search is blue or indigo, execution is amber, mutation is magenta, interaction is blue, delegation is violet, skill reads are lime/olive, compression is copper, and other session/planning/orchestration is subdued slate. Skill and compression labels retain their distinct tones in collapsed activity headers as well as child rows. Each role has readable light and dark theme tokens. Completed, failed, and diagnostic icons use separate success/error/warning tokens, never the operation hue.
- Legacy ACP updates without a programmatic name or raw input fall back to splitting the existing title.
- Consecutive thinking and tool entries share one collapsible activity group until a visible user, assistant, or system message boundary.
- Assistant prose immediately following an activity group starts below a full-width, neutral semantic border with compact breathing room. This applies to intermediate commentary as well as the final answer, including repeated tool → prose → tool → prose alternation; it does not imply turn completion. The border stays outside the disclosure body and remains visible with the group collapsed or expanded. User/system messages, uninterrupted assistant prose, and a trailing activity group do not gain this border.
- Collapsed activity headers list normalized presentation names plus `thinking` once in first-seen order (for example `thinking, todo, repo_knowledge` even when a name occurs more than once).
- Collapsed group list names always render in their native semantic tool tones regardless of liveness; liveness does not add or remove name emphasis. A live thought is active only when it has a recorded start and no recorded end, so replay data without timing metadata is not presented as live.
- Expanding an activity group preserves the original interleaving of thinking blocks and individual tool calls. Child `thinking` rows stay muted even while live; the collapsed header is a single line of natively-toned names plus the elapsed duration, with no status or action text.
- The group itself does not hydrate tool bodies. Individual result disclosures hydrate on demand; closed groups/results do not mount their expensive Markdown, diffs, or attachment content. Reopening retains individual disclosure state within the same session, while switching sessions resets it even when replay IDs match.
- A completed edit result patch is preferred because it carries full context. Otherwise explicit ACP diff content is used; when both are absent (notably session replay), edit and write diffs are reconstructed from recorded raw input.
- Apply-patch input is rendered as one diff surface for both `*** Begin Patch` and unified-diff forms.
- Failed mutations do not present their requested patch as an applied diff.
- The mutation result text follows the diff and preserves all text blocks in order, including normal success output, `LSP diagnostics:`, and `comment-checker` notices.
- Completed mutation rows with LSP output use an alert icon: error-colored when diagnostics contain an error, otherwise warning-colored, matching the TUI rule.
- Activity-group summaries show no lifecycle status, settled outcome, or icons — only the natively-toned name list and the elapsed time on one line. They do not inherit failed/success outcome color or LSP warning/error attention from child tool rows; those signals, including the failed status icon, stay on the concrete child call that produced them.
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
- `desktop/src/lib/tool-input.ts`
- `desktop/src/lib/syntax-highlight.ts`
- `desktop/src/lib/syntax-highlight.test.ts`
- `desktop/src/lib/gdscript-highlight.ts`
- `desktop/src/lib/tool-input.test.ts`
- `desktop/src/components/ToolResult.test.ts`
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
