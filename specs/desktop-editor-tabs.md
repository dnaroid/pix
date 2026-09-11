# Desktop workspace editor tabs

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Treat file/media preview and Source Control diff/review as long-lived workbench editors instead of modal overlays, while keeping conversation session tabs as a separate runtime-navigation layer.

## Behavior

- The titlebar Session tab strip continues to select conversation/runtime identity. Workspace editor tabs live inside the central workbench and select the visible surface for the active workspace/session.
- The conversation is the non-closable base editor. When a file/media preview or Git diff is open, the editor strip exposes **Conversation**, the current **Preview**, and/or the current **Git Diff** as separate tabs.
- The editor strip is hidden when Conversation is the only editor, avoiding permanent duplicate chrome. Opening the first auxiliary editor reveals the strip.
- The editor host always occupies the workbench's flexible second grid row. When the editor strip is hidden, its first grid row collapses to zero instead of letting the editor host auto-place into that `auto` row; the Conversation transcript therefore consumes the remaining height and keeps the composer anchored to the bottom edge.
- The shared editor host is an explicit full-height grid area. Conversation
  stretches to that area so the transcript owns all spare vertical space and the
  composer remains anchored to the bottom even for an empty or short transcript.
- Preview and Git Diff no longer use modal backdrops or modal focus trapping. They consume the central editor region and share the existing Session inspector/status chrome around that region.
- Switching editor tabs does not unmount the still-open Conversation, Preview, or Git Diff surface. Conversation/composer state, preview edit draft/scroll state, and diff review output therefore survive ordinary editor switching.
- Switching conversation sessions returns the visible workspace editor to Conversation but does not discard open Preview or Git Diff editors. Both are workspace work surfaces: Preview draft/history/scroll and Git review state remain available as inactive tabs until explicitly closed or until the workspace changes. In-flight preview reads are still generation-invalidated across session changes so a late request cannot unexpectedly steal the editor after the user changes conversations.
- Opening a project/local file or supported media activates the Preview editor. Internal Markdown navigation continues to use the existing back/forward preview-history stack inside that one Preview tab instead of creating a new editor tab for every followed link.
- Opening a Source Control diff or starting LLM review activates the Git Diff editor. Opening a file reference from that editor activates Preview while leaving the diff editor open for return navigation.
- Preview Markdown editing keeps its local draft when switching editor tabs. The Preview tab shows an unsaved indicator while dirty. Closing Preview asks before discarding an unsaved edit; cancelling that confirmation keeps the editor open and focused.
- Session switching never discards a dirty Preview editor. Workspace changes and Git mutations that reload/switch project state require explicit confirmation before they invalidate an unsaved Preview draft.
- Workspace editor tabs use a horizontal roving-focus tablist. Left/Right and Home/End move focus without activation, Enter/Space activate through native button behavior, and Delete closes a closable editor.
- After closing an editor, focus moves to a logical neighboring editor tab. If closing the last auxiliary editor removes the editor strip, focus returns to the Conversation composer rather than falling to the document body.
- Command Palette entries expose **Show Conversation**, **Show Preview**, **Show Git Diff**, and **Close Active Editor** only when those actions are currently meaningful. No window-close shortcut is repurposed for editor close.

## Non-goals

- Opening multiple independent file-preview tabs. Preview retains its existing browser-like history stack as one work surface.
- Mixing file/diff editor tabs into the titlebar Session tab membership or ACP/TUI tab synchronization.
- Persisting workspace editor tabs across application restarts.
- Converting bounded settings, elicitation, or model-selection flows into editor tabs.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/components/WorkspaceEditorTabs.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/GitDiffPane.svelte`
- `desktop/src/lib/workspace-editors.ts`
- `desktop/src/lib/preview-history.ts`
- `desktop/src/lib/desktop-commands.ts`

## Verification

- Workspace-editor helper tests cover close fallback and stale-active normalization.
- Component source tests cover roving tab semantics, keyboard close, logical fallback, and the absence of modal roots in Preview/Diff surfaces.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
