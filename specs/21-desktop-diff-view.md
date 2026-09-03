# Spec: Desktop diff view

## Type

Change

## Goal

Render file-edit results and `git diff` shell output as readable inline diffs in Pix Desktop, following the existing TUI behavior.

## Scope

- Preserve ACP structured `diff` tool content instead of flattening it into plain text.
- Render Edit/Write structured old/new text with added, removed, and unchanged lines.
- Render output from shell `git diff` commands as a unified diff.
- Keep ordinary tool output, read results, and non-diff shell commands unchanged.

## Behavior

- File paths and addition/deletion counts appear in a compact diff header.
- Added, removed, hunk, metadata, and context rows have distinct semantic treatment in light and dark themes.
- Unified-diff line numbers are shown when hunk metadata provides them.
- `+` and `-` are change markers only in column zero, so indented Markdown bullets are not misclassified.
- ANSI control sequences in shell diffs are removed before browser rendering.
- Large structured replacements use a bounded fallback instead of quadratic line matching.
- Diff panes scroll vertically and horizontally without widening the transcript.

## Non-goals

- Editing or applying a diff from the viewer.
- Syntax highlighting inside changed lines.
- Detecting arbitrary commands that happen to print diff-like text; shell detection mirrors the TUI's `git diff` command rule.

## Related files

- `desktop/src/lib/diff.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/components/DiffView.svelte`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/TranscriptPane.svelte`

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
