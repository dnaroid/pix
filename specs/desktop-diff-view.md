# Desktop diff view

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Render file-edit results and `git diff` shell output as readable inline diffs in Pix Desktop, following the existing TUI behavior.

## Scope

- Preserve ACP structured `diff` tool content instead of flattening it into plain text.
- Render Edit/Write structured old/new text with added, removed, and unchanged lines.
- Render output from shell `git diff` commands as a unified diff.
- Keep ordinary tool output, read results, and non-diff shell commands unchanged.
- Present Source Control diff/review as a central workspace editor rather than a modal overlay.

## Behavior

- File paths and addition/deletion counts appear in a compact diff header.
- Added, removed, hunk, metadata, and context rows have distinct semantic treatment in light and dark themes.
- Unified-diff line numbers are shown when hunk metadata provides them.
- `+` and `-` are change markers only in column zero, so indented Markdown bullets are not misclassified.
- ANSI control sequences in shell diffs are removed before browser rendering.
- Large structured replacements use a bounded fallback instead of quadratic line matching.
- Diff panes scroll vertically and horizontally without widening the transcript.
- Inline transcript diffs remain inline. Source Control `git diff` actions open/select the Git Diff tab in the unified top workbench strip, which preserves its LLM review output while the user switches to conversation or Preview tabs.
- File links opened from Git Diff activate the Preview workbench tab without closing Git Diff, allowing users to move between source and review without stacked modal dialogs or a second nested tab strip.
- When an LLM review has actionable findings, Git Diff exposes both `Copy prompt` and `Fix in new session`. Copy places the exact resolution prompt that the new-session action would submit onto the clipboard without creating a session; after a successful clipboard write, the button briefly changes to `Copied` with a check icon as visible confirmation. Copy is disabled while review refresh, resolution startup, Source Control busy state or an explicitly stale review could make that visible review unsafe to use.
- A Review/Diff view toggle allocates the editor height to the selected content instead of constraining review output to a small split. It is a view control within the existing Git Diff workbench tab, not a second workbench tablist. Daily commit/review workflows, retained review checkpoints and freshness-checked fix-session handoff are defined in `specs/desktop-git-workflows.md`.

## Non-goals

- Editing or applying a diff from the viewer.
- Syntax highlighting inside changed lines.
- Detecting arbitrary commands that happen to print diff-like text; shell detection mirrors the TUI's `git diff` command rule.

## Related files

- `desktop/src/lib/diff.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/transcript-content.ts`
- `desktop/src/lib/transcript-reducer.ts`
- `desktop/src/lib/transcript-types.ts`
- `desktop/src/components/DiffView.svelte`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/GitDiffPane.svelte`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/app/git-assist.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/App.svelte`

## Verification

- Unit tests cover structured diffs, unified hunk numbering, ANSI removal, marker classification, shell command detection, and ACP transcript preservation.
- `cd desktop && npm test`
- `cd desktop && npm run check`
- `cd desktop && npm run build:web`
- `npm run check`

## Evidence

- Confirmed by code: TUI shell renderer marks `git diff` commands with `bodyStyle: "diff"`; TUI diff lines classify metadata, hunks, additions, and deletions only at column zero.
- Confirmed by code: the ACP translator already emits structured diff content for Edit and Write tools.
- Confirmed by tests: TUI tests cover shell diff detection and prevent indented bullets from receiving diff colors.
