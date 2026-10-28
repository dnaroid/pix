---
kind: spec
status: active
---

# Desktop project Wiki

## Behavior

The Workspace Activity Bar has a **Wiki** destination beside Project. It uses
the shared sidebar selection, collapse, resize and keyboard behavior. The Wiki
is a project directory containing Markdown pages, nested sections and ordinary
assets; there is no separate document database or generated-code contract.

`.pi/workspace.jsonc` configures the location:

```jsonc
{
  "wiki": {
    "path": "wiki",
    "index": "index.md"
  }
}
```

Both fields are optional. `path` is relative to the project; `index` is relative
to that directory and may include subdirectories. The resulting default home
page is `wiki/index.md`. JSONC comments, trailing commas and unrelated properties
are accepted. Opening Wiki does not create files or rewrite the configuration.
The generated workspace schema describes these fields for editor completion.

Paths must stay inside the project. Absolute paths, parent traversal, control
characters, Git metadata and disposable `.pi/artifacts` / `.pi/subagents`
storage are rejected. The index must be `.md` or `.markdown`. Invalid JSONC or
invalid Wiki settings produce a visible error rather than selecting a different
directory. Native file operations retain their existing existence, symlink and
workspace-containment checks.

### Navigation and authoring

- A missing Wiki shows **Create Wiki**. This explicitly creates missing parent
  directories and a small Markdown home page, without overwriting an existing
  index. An existing root without its configured index shows **Automatic contents**
  beside the optional **Create index** action.
  Partial filesystem failures remain visible and can be retried; the UI never
  rolls back by deleting preexisting content.
- The panel places a **Search Wiki** input above the existing tree; it replaces
  the redundant Wiki-home toolbar row. Editing the query invalidates current
  results; press Enter to search. Escape or the clear control cancels the search,
  restores the same mounted tree and returns focus to the input. Results show a
  page title, path and excerpt and open in the existing Wiki Preview route.
  Opening a result preserves the sidebar query and results without rerunning the
  search; the active result is marked with selected styling and `aria-current`.
  The result's source line range is passed to Preview as a search range, separate
  from source-view line ranges. Preview remains rendered Markdown and highlights
  top-level rendered blocks whose source ranges intersect the search fragment.
  The reveal runs after saved scroll-position restoration; history retains both
  the range and scroll position. Search-range highlighting does not change
  ordinary source-link navigation, which opens the source view with its existing
  line-range behavior. Cancelling the search prevents stale results from
  revealing a range.
  Search reuses native repository search for Knowledge only, scoped to the
  configured Wiki directory before retrieval; it deduplicates files and respects
  existing source selection without enabling sources. Lexical results are shown
  first; hybrid enrichment and native reranking are conditional on global
  configuration. Search notices are displayed and logged, and configuration or
  policy changes invalidate results. The tree reads one directory at a time;
  unopened descendants are not scanned. Index pages are represented by
  their folders and are hidden as separate file rows. Selecting **Contents**
  opens the configured Wiki home, including a custom or nested index path. When
  the Wiki root or a nested folder has no applicable index, opening it shows
  generated, read-only Markdown contents in the existing Preview. The listing
  includes immediate child sections, Markdown pages and other files, grouped
  under Sections, Pages and Files; links are escaped and relative. Images and
  videos recognized by the existing media-path classifier appear as standalone
  Markdown image links under Media and use the ordinary Markdown renderer and
  resolver (including its inline image and video-player behavior). No file is
  written, and only a truly empty folder shows “This folder is empty.” A real
  configured or conventional index takes precedence whenever the folder is
  opened again. Preview directory
  links use this same behavior inside the Wiki; directories outside it retain
  Files reveal. Generated contents support Preview back/forward history, but
  not Edit, external editor or Copy file. Their tab and reverse navigation
  identify the real directory rather than a virtual file. Delayed results are
  discarded when navigation/workspace is stale. The configuration footer is
  not shown in the panel.
  Selecting a nested folder opens its configured home when that index is a
  direct child, otherwise `index.md` or `index.markdown` in that order. Folders
  without an index open generated contents without changing expansion. Selection
  highlights the owning folder when its index or generated contents are open.
  Other folders and files remain sorted by name, with
  folders first; Markdown extensions are omitted from page labels.
- The tree reuses the existing Explorer keyboard controller: one Tab entry,
  arrow/Home/End movement, directory expansion/collapse, type-ahead and
  Shift+Enter for the configured external editor. Enter/Space on a folder opens
  its index or generated contents; the separate chevron and Left/Right arrows expand/collapse without
  opening a page. Focus and selected document
  are separate. Expanded visible folders refresh while the panel is foreground,
  and explicit Refresh also reloads the Wiki configuration. Window focus reloads
  configuration; closing the panel releases polling and pending UI ownership.
- **New page** creates an empty Markdown file in the focused directory (or the
  parent of a focused file). `.md` is appended unless the name already ends in
  `.md` or `.markdown`. **New section** creates a folder. Both use the existing
  inline filename editor and native exclusive file creation. Enter submits;
  Escape cancels. Creating an index opens it for editing and focuses its folder
  even though the new file is hidden from the tree. Files remain available through **Show Wiki folder in Files**,
  where the existing rename, move, clipboard and recovery commands apply.
- A page opens in the existing Preview workbench tab. Sidebar page navigation
  and document links use its history. Assets use the existing image/media/file
  Preview routing. Wiki is not a new session or an additional nested tab strip.
- Explicit Markdown links and media paths in a Wiki page resolve relative to
  that document, including `../` within the project. Relative resolution never
  escapes the project. The ordinary transcript and agent-reference root-path
  interpretation is unchanged. Same-document heading links use the existing
  Preview heading anchors.
- Workspace replacement, disposal and delayed native replies cannot populate
  another project's tree, open a stale page or continue a multi-step scaffold
  after its owner is invalidated. File creation shares the existing Preview
  mutation reservation and requires a dirty draft to be resolved first.

### Markdown WYSIWYG

Markdown **Edit** defaults to a visual Milkdown/ProseMirror editor. The editor
loads only when needed. **Visual** and **Source** switch between rendered
document editing and the existing Markdown textarea without saving or dropping
the current draft. Non-Markdown files and source-line previews retain source
editing by default.

The visual toolbar supports paragraphs, headings, bold, italic, lists, task
checkboxes, quotes, inline code, fenced code, tables, links, images and Undo/Redo.
Tables expose row/column insertion and deletion. Image insertion accepts a
document-relative asset path or HTTP(S) URL; it does not import clipboard image
files into the Wiki. Files can be placed in the Wiki through the Files panel.
Resolved image URLs are DOM-only: saved Markdown retains the authored source.
Cmd/Ctrl-click follows a link. Toolbars have a single roving Tab stop and
ArrowLeft/ArrowRight/Home/End navigation.

The saved format is Markdown, never HTML or editor JSON. Unedited documents
retain their original source exactly, including after undoing to the original
document. Editing may normalize Markdown whitespace and delimiter style. YAML
and TOML frontmatter bytes are retained separately. Raw HTML/MDX that cannot
round-trip through the visual schema requires Source mode; it is not silently
discarded. Fenced HTML remains a normal editable code block.

Changes publish synchronously and Save/Command-S reads the current editor
document, including the last keystroke. Existing Preview dirty state, close
confirmation, serialized writes and preservation of text entered during saving
apply to both modes. Opening another Preview target or moving history cannot
replace a dirty draft. The user saves or discards it first.

Ordinary project-file saves with a loaded `expectedContent` reread disk content
immediately before replacement. A mismatch reports a conflict and leaves the
draft and externally edited file intact. This is optimistic stale-save
detection, not a lock against external writers in the final check/rename window.
The workspace configuration retains its existing locked compare-and-swap writer.

## Integration

Wiki documents use the existing native Code/Knowledge indexing rules; the Wiki
panel does not enable a search source or add a search index.
See [native repository search](../../search/native-repository-search.md).

The suite adds a short `project_wiki_guidance` system-prompt section when the
current project's configured Wiki index exists as a regular file. This also
recognizes the default `wiki/index.md` without requiring explicit configuration.
An empty folder or settings alone do not initialize the Wiki. Configuration and
index paths must resolve inside the project; invalid settings or a missing index
omit the hint. The hook creates no files and reads no Wiki document contents.

The hint directs durable project documentation and specifications to the actual
Wiki folder, names its index, and asks agents to follow the structure and keep
index links current. Explicit user destinations and required fixed-path files
take precedence; disposable task output retains its existing artifact policy.
Settings and index existence are checked asynchronously before every agent run,
including within an existing session. The hook updates/removes its own section
without duplicating guidance or retaining another project's path. Earlier opaque
prompt overrides keep their content and receive the same conditional hint.
This applies wherever the suite's agent hooks run, independently of the UI
profile; the headless MCP tool bridge does not export agent prompts.

The index is an authored Markdown home page; tree structure follows directories.
There is no automatic table-of-contents rewrite, backlink graph, wiki-link
syntax, drag ordering or filename migration in this change.

## Implementation

- `desktop/src/components/ProjectWikiPanel.svelte`
- `desktop/src/components/ProjectWikiSearch.svelte`
- `desktop/src/components/ProjectWikiSearch.test.ts`
- `desktop/src/lib/project-wiki-search.ts` and
  `desktop/src/lib/project-wiki-search.test.ts`
- `desktop/src/components/ProjectWikiTree.svelte`
- `desktop/src/components/project-wiki-controller.svelte.ts`
- `desktop/src/lib/project-wiki.ts`
- `desktop/src/lib/project-wiki-navigation.ts`
- `external/pi-tools-suite/src/lib/project-wiki.ts` (shared configuration)
- `external/pi-tools-suite/src/project-wiki-prompt.ts`
- `desktop/src/components/WikiMarkdownEditor.svelte`
- `desktop/src/lib/wiki-markdown-editor.ts`
- `desktop/src/lib/wiki-markdown-content.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/lib/markdown-context.ts`
- `desktop/src/lib/markdown-links.ts`
- `desktop/src-tauri/src/lib.rs`
- `src/schemas/workspace-schema.ts` and generated `schemas/workspace.json`

## Verification

Focused Vitest covers configuration/path validation, delayed workspace reads,
scaffold disposal, existing-index preservation, Preview draft protection,
document-relative links and Markdown metadata/URL policy. Native
`project_file_expected_content_*` tests cover conflict preservation, matching
and absent expected-content saves. The Desktop dropdown/disclosure regressions,
Svelte/TypeScript check and production web build remain applicable.

`external/pi-tools-suite/test/project-wiki-prompt.test.ts` covers conditional
injection, default/custom JSONC paths, config changes, missing/invalid indexes,
workspace changes, external symlinks, opaque overrides and safe path quoting.

`desktop/src/lib/project-wiki-navigation.test.ts` covers index selection and
late folder lookups superseded by navigation, configuration changes or teardown.
The panel browser smoke checks folder click/keyboard activation, independent
disclosures, hidden index rows, delayed-navigation cancellation through
**Contents**, and creating/editing an index through the UI. The script was not
run for the Wiki search sidebar change.

The browser smoke exercises real Svelte/Milkdown DOM behavior with isolated
fixtures and mocked host IPC; it is distinct from native macOS UI verification.

- `node desktop/scripts/wiki-smoke.mjs` checks editing, immediate save, exact
  undo, tables/tasks, links, image paths, toolbar navigation and Source fallback.
- `node desktop/scripts/wiki-panel-smoke.mjs` checks the actual Wiki panel and
  Preview together: configured nested initialization, section/page creation,
  visual/source saves and relative page/image navigation.

Both scripts write results and light/dark screenshots to a unique directory
under `.pi/artifacts/`, or to `WIKI_SMOKE_OUTPUT` when supplied by a test runner.
