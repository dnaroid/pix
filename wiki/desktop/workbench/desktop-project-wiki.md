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
- **Open as HTML in browser** (globe button) exports every Markdown page to one
  self-contained `index.html` in the system temp folder
  (`pix-wiki-export-<hash>/`) and opens it in the default browser from
  `file://`, with no server. The page follows the system light/dark theme,
  has a sidebar tree, in-page routing (`#/path`) and global full-text search
  (`/` or Cmd/Ctrl+K). Raw HTML in Markdown is escaped, unsafe link schemes
  are dropped and images load from the Wiki folder. Saved consistency reports
  and check stamps are omitted from exported pages, titles and search text;
  literal examples inside code remain visible. Symlinks and hidden
  entries are skipped; macOS only. Implemented in
  `desktop/src-tauri/src/wiki_html_export.rs`.
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

### Contradiction checks

For `.md` and `.markdown` pages inside the selected project's configured Wiki,
Preview **Save** and Cmd/Ctrl+S check the current draft before writing it. The
**Check consistency** action is available in ordinary Preview and in both Visual
and Source editing modes. In Preview it checks the saved page and can update
only its inline check metadata; in Edit it checks the draft without saving it.
Manual checks belong to a project-owned FIFO queue, with one manual request
running at a time. Navigating to another page, closing Preview, changing editor
mode or hiding the Wiki panel does not cancel the task. The queue captures the
page text and its raw saved baseline when Check is pressed; later navigation
cannot substitute another page's text or save target. Identical active requests
are deduplicated. It holds up to 16 active tasks and the 32 most recent terminal
tasks in memory. Switching projects or disposing the workbench cancels and
clears this queue; running tasks do not resume after an application restart.
Completed reports persisted inside their pages are restored when those pages reopen.

The Wiki sidebar's **Checks** disclosure shows queued/running tasks and retained
reports, including reports for an earlier document or draft snapshot. A terminal
notification can reopen the page. Reopening an unchanged page restores its
matching report and in-flight state. A report for changed text remains available
in the task list without being presented as a check of the new text. Explicit
Cancel stops a queued or running task; Dismiss removes a terminal entry.
Cancelling a request does not start the next request until the previous backend
promise settles. An already-started native atomic write cannot be recalled.

Pre-save checks keep their editor/draft ownership and cancellation rules; a
background manual result never authorizes saving an edited draft. A saved-page
background result can update its original file's footer only through the raw
expected-content guard. If recording fails or the file has changed, the report
is retained with a recording notice and the new file is not overwritten.

**New page** still
creates an empty file; its first content save runs the check. Other project-file
saves retain their existing behavior.

Related pages come from the existing native Knowledge search, scoped to the
same project's Wiki before retrieval. Hybrid queries use native BM25 and vector
retrieval with reciprocal-rank fusion and the configured optional reranker.
Existing source selection, exclusions and provider configuration apply; checking
a page does not enable sources or configure providers. Disabled, unavailable or
incomplete semantic retrieval leaves the check incomplete, even when lexical
matches are available. The saved version of the draft itself is excluded from
external evidence. Evidence is restricted to safe `.md` and `.markdown` pages.
Other Knowledge-supported formats inside the Wiki, such as an asset's `.txt`
companion, are excluded normally before reading their originals; they do not
make the Markdown comparison incomplete. Unsafe/private paths and results
outside the configured Wiki remain actual retrieval failures.

A separate sessionless model call compares the draft with original source text.
It uses the Search answer-model and thinking preferences, with the existing Pix
default fallback, and the normal provider runtime, credentials and extension
loading. It creates no conversation. Drafts, sources and their metadata are
untrusted data, including any instructions embedded in them. The comparison
asks for incompatible claims about the same entity, environment, version and
time period. Explicit supersession, historical values and different scopes do
not by themselves constitute contradictions. The model does not choose which
claim is authoritative or rewrite either document.
The report names the judge model used for that request. Its task is to compare
claims within the supplied draft and passages; a bounded selection alone is not
a reason to abstain. Missing conditions that materially change the verdict on
specific claims remain a real uncertainty.

`knowledgeCheck.reportLanguage` controls model explanations, uncertainty prose,
report labels and checker-owned diagnostics. It accepts `en` and `ru`; the
user-global Desktop value overrides the user-global Tools Suite value, with
English as the fallback. An empty Desktop value inherits the suite setting.
Preferences are read for each check. Source quotations, paths and structured
identifiers remain unchanged, as do unknown native/provider diagnostics.
See [configuration](../../configuration/guide.md#wiki-contradiction-report-language)
for the settings locations and example.

The operation has explicit budgets:

| Input or stage | Limit |
| --- | --- |
| Draft | 48,000 characters |
| Related-document retrieval | Up to 8 queries within a shared 45-second budget |
| External evidence | Up to 12 source pages and 48,000 characters including context |
| Source excerpts | Matched line ranges are reserved first; remaining context is shared across selected pages within the total evidence budget |
| Whole check | 120 seconds, including retrieval and model work |

Queries sample representative sections when the draft exceeds the query budget.
Source passages retain bounded leading context for lifecycle and scope metadata.
Ordinary query sampling, top-candidate/source limits, excerpts and context
reduction describe the review scope in a compact coverage summary. They do not
make a successfully completed comparison of the selected passages incomplete.
Passages and leading context end on complete lines; optional context never
displaces the reserved matched range. Timeouts, failed or stale retrieval,
unavailable/incomplete semantics, unreadable sources and genuine comparison
uncertainty still produce notices and prevent a clear result. Sources
are reread from validated project files; cached search snippets are not used as
proof. The model can also compare two claims within the draft. With zero external
evidence, internal findings remain available, but cross-document consistency
cannot be established.

Findings require known source IDs and exact, uniquely occurring quotations in
the draft and source passage after newline normalization. Line ranges are
computed from those texts. Metadata context alone cannot ground a quote.
Malformed output, fabricated or ambiguous quotations and model uncertainties
make the check incomplete; independently valid findings can still be shown.

- **No contradictions found in the reviewed passages** allows the initiating
  Save to write that same draft only when retrieval of the selected material and comparison completed.
  A manual check in Edit does not save the draft.
- **Potential contradictions found** preserves the draft and displays paired
  quotations, paths, line ranges and an explanation. Coverage notices remain
  visible when other parts of the check were incomplete.
- **Consistency check is incomplete** preserves the draft and reports missing
  coverage or a failed check. It never automatically counts as a clear result.

The report is a collapsible document in both Preview and Edit, and in the
retained sidebar task. Its summary keeps status, counts and actions accessible
while collapsed. The expanded body separates established contradictions,
material uncertainties, checker diagnostics and the actual reviewed source
passages. Each finding and uncertainty pairs the draft quote with an original
source quote, real project-relative paths and inclusive line ranges. Individual
findings and source excerpts can be expanded independently. Model prose is
rendered as text, not executable HTML.

Uncertainties use the same exact-quotation grounding as conflicts: a missing
deciding condition is explained separately from the two actual claims. A pair
returned in both classifications remains an uncertainty, never a proven conflict.
Legacy free-text uncertainties remain visible as diagnostics without invented
citations. New results retain up to 12 original evidence passages and 48,000
characters; optional background context does not become quoted evidence. Older
reports without source inventories explicitly indicate that those snapshots
were not retained.

A citation opens the saved source in rendered Markdown Preview, retaining
back/forward history. Before highlighting, Preview locates the exact quote
uniquely in the current file, normalizing line endings and recalculating moved
line ranges. A missing or ambiguous quote shows a stale-evidence notice and
never highlights old line numbers. When Markdown formatting prevents exact
rendered-text highlighting, the containing source-mapped block is highlighted
with an explicit explanation and the literal quote. Ordinary source links and
Wiki search ranges retain their existing behavior. Evidence highlights are
removed on navigation, editing, inactive Preview and disposal.

**Resolve in new session** / **Разрулить в новой сессии** is an explicit action
on a completed non-clear report. It creates and selects a normal conversation
in that report's project and submits the complete report with the exact captured
document text, bound to its SHA-256. Opening, expanding or completing a report
never starts a conversation. Duplicate clicks during startup cannot create
multiple sessions. Workspace/client replacement and project reset invalidate
pending startup; a newly allocated stale session is closed without submitting
the task.

The resolution task asks the agent to reread project instructions, Wiki settings
and current originals; establish scope and authority; preserve newer edits; and
fix only confirmed contradictions in related Wiki documents. A captured draft
may be unsaved. Missing authoritative rules require a specific question before
a disputed edit. Quotes, model explanations and captured documents remain
untrusted evidence. The action uses ordinary session model settings, does not
change the judge model, and does not authorize commits or publication. The
session remains available through the normal conversation history.

**Save anyway** explicitly saves the reviewed draft despite conflicts or an
incomplete check. **Check again** retries; **Cancel check** stops pending work,
and **Dismiss** closes a completed report. Editing invalidates findings as a
review of the current draft and its override permission; a manual task and its
captured report remain in the project queue. Normal Save performs a fresh check. Source navigation
retains Preview's dirty-draft protection, so links are disabled while the draft
is dirty; quoted evidence remains visible in the report.

Before returning a result, the service revalidates the Wiki corpus metadata,
Wiki configuration and hashes of the draft's saved baseline and selected source
files. Changed documents, including newly added or previously unselected pages,
invalidate the result. Incomplete corpus validation also prevents a clear result.
Draft and project ownership guards discard stale or cancelled pre-save replies;
manual jobs retain their own captured file identity through Preview navigation.
Before publishing a manual report, its path and SHA-256 must match that job's
snapshot. Late replies cannot save a different draft or project. The optimistic
disk-save check described above still applies.

#### Reports saved inside the document

A completed non-clear check of a saved page stores its full validated report in
one hidden `<!-- pix:wiki-report ... -->` block at the beginning of the Markdown
file, after a BOM or existing YAML/TOML frontmatter when present. The versioned
JSON envelope records the check time and report, including the document SHA-256,
judge, language, evidence quotations and source inventory. It creates no sidecar.
The block is bounded to 384 KiB of UTF-8 and escapes HTML comment delimiters.
Original body bytes, frontmatter, line endings and final newline are preserved.

Opening that page after a restart restores the report without retrieval or a
model call. Its current/stale state is checked against the logical body hash and
file path. A changed or renamed page keeps the historical report visible with a
stale label; that report cannot authorize Save anyway or start a resolution task
for a different snapshot. Source links still validate quotes against current
originals. Dismiss hides the report in the current Preview; it does not erase
stored evidence from the file.

A subsequent complete clear check removes the report block and records the small
success footer. A subsequent non-clear result replaces the earlier report and
removes any success footer. An interrupted/failed request or failed raw-content
compare-and-swap cannot erase the previous report or overwrite newer document
content. Saving edits without a completed new verdict preserves the previous
valid report with its old hash, so it remains available as stale evidence.
An unsaved Edit check does not write the document; explicitly saving
that exact reviewed draft with **Save anyway** stores its non-clear report along
with the draft.

Both forms of application metadata are excluded from the logical document hash,
editor text, draft queries and judge evidence. Knowledge indexing blanks reserved
metadata before chunking and embedding, retaining physical source-line counts
and raw source freshness checks. Large report lines therefore cannot exclude
the page from indexing or become spurious evidence in later checks. The existing
source-body read budget remains 512 KiB, with separately bounded metadata overhead.

#### Saved-version check marks

A successful check can append one hidden HTML comment with the reserved
`pix:wiki-check` prefix to the Markdown file. The metadata records its format
version, successful status, SHA-256 of the exact UTF-8 logical document text, check
time, judge model, report language and bounded source counts. The comment
and any saved report block are excluded from the hash and model input. Restamping replaces the old
footer, preserves the document's original text and line endings, and creates
no sidecar file. Frontmatter remains at the start of the document.

The current saved version is green in Preview and its Wiki page-file row only
when the marker is valid and its content hash matches. Invalid or duplicate
markers and changed text do not earn a green mark. The normal foreground Wiki
listing refresh rechecks visible page files, so external edits remove their
mark on refresh. Directories retain their ordinary styling; their index pages
show the saved-version status when opened in Preview.

Tree annotation uses a bounded in-memory cache of 4096 results, including pages
without a valid marker. The macOS cache identity includes canonical workspace
and path, file size, modification/change timestamps, device and inode. Safe-path
and metadata checks still run on each listing; unchanged files need no repeated
content read or SHA-256. File edits and atomic replacements invalidate the entry.
Cache locks are not held during filesystem reads or hashing. Uncached reads
remain bounded to 512 KiB per file and 8 MiB per directory listing; cache hits
consume no read budget. Uncached pages that cannot be read within those limits
are not shown as verified.
The existing refresh reads the root and expanded visible directories only,
waits five seconds after each pass, and pauses when the window is not foreground.
It never calls search or the judge just to display a saved check mark.

In Preview, a completed clear check writes only the footer through the same
expected-content guard used by ordinary saves. A completed non-clear check
replaces an earlier success footer with its saved report block. In Edit, a manual check leaves the file
untouched; a successful Save writes the checked body and footer together.
**Save anyway** writes no success marker; it records the reviewed non-clear report when available. Explicit cancellation, a changed
snapshot or an external disk change cannot authorize a new late marker write.
Navigation alone does not cancel a manually queued saved-page check.
Dirty drafts are not presented as a checked saved version.

The mark records the last successful bounded check of this file version.
Other Wiki pages can change later and create a new contradiction without
changing this file's hash; run the check again when current cross-document
consistency matters. A marker never bypasses the checker or authorizes saving
a different draft.

The result describes the retrieved evidence, not an exhaustive proof about the
Wiki. Literal quotation checks establish provenance; the model can still miss
or misclassify a semantic contradiction. This flow adds no filesystem watcher,
automatic content rewrite or interception of direct agent/external-editor writes.

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

The hint identifies the Wiki as the project's knowledge base and directs agents
to save and maintain durable project knowledge, documentation and
specifications in the actual Wiki folder. It names the index, asks agents to
follow the existing Wiki structure and keep documentation and index links
current. Explicit user destinations and required fixed-path files take
precedence; disposable task output retains its existing artifact policy.
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
- `desktop/src/components/WikiConsistencyReport.svelte`
- `desktop/src/components/wiki-consistency-report-text.ts`
- `desktop/src/components/WikiConsistencyCitation.svelte`
- `desktop/src/components/preview-evidence-controller.svelte.ts`
- `desktop/src/lib/knowledge-citation.ts`
- `desktop/src/lib/knowledge-resolution.ts` and
  `desktop/src/app/knowledge-resolution.svelte.ts`
- `desktop/src/components/preview-editor-controller.svelte.ts`
- `desktop/src/app/project-documents.svelte.ts`
- `desktop/src/app/project-knowledge-queue.svelte.ts`
- `desktop/src/components/ProjectWikiCheckQueue.svelte`
- `acp/src/knowledge/contract.ts` and `acp/src/knowledge/request.ts`
- `acp/src/knowledge/evidence.ts` and `acp/src/knowledge/native-search.ts`
- `acp/src/knowledge/comparison.ts` and `acp/src/knowledge/service.ts`
- `acp/src/knowledge/preferences.ts` and `acp/src/knowledge/report-language.ts`
- `acp/src/knowledge/stamp.ts`
- `acp/src/acp/pix-acp-agent.ts` (Desktop check RPC)
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/lib/markdown-context.ts`
- `desktop/src/lib/markdown-links.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/wiki_consistency.rs`
- `src/schemas/workspace-schema.ts` and generated `schemas/workspace.json`

## Verification

Contradiction-check verification uses the following focused targets:

- `acp/test/knowledge-comparison.test.ts`: structured model-output validation,
  exact quote provenance, derived line ranges, internal conflicts and cancellation.
- `acp/test/knowledge-evidence.test.ts`: project/Wiki scoping, original source
  reads, fair context allocation, line boundaries, ordinary coverage limits,
  actual retrieval failures and corpus/source freshness.
- `acp/test/knowledge-service.test.ts` and
  `acp/test/knowledge-native-search.test.ts`: model/runtime ownership, deadlines,
  late disposal, subprocess protocol and cancellation.
- `acp/test/knowledge-rpc.test.ts`: Desktop request validation and sessionless RPC.
- `acp/test/knowledge-preferences.test.ts`: global report-language inheritance,
  override, invalid values and per-request updates.
- `acp/test/knowledge-stamp.test.ts`, `acp/test/knowledge-request-stamp.test.ts`
  and native `wiki_consistency` tests: exact body hashes, bounded inline metadata,
  shared TypeScript/Rust fixtures, line preservation, safe directory reads,
  metadata-cache reuse, replacement invalidation and bounded eviction.
- `desktop/src/app/project-knowledge-check.test.ts` and
  `desktop/src/components/preview-editor-controller.test.ts`: Wiki eligibility,
  current draft ownership, Preview checks, persisted marks, explicit override,
  retry/cancel and stale-save guards.
- `desktop/src/app/project-document-save-guard.test.ts`: strict raw baselines,
  cancellation before queued writes and committed-baseline publication.
- `desktop/src/app/project-knowledge-queue.test.ts` and
  `desktop/src/app/project-manual-knowledge-check.test.ts`: FIFO ordering,
  snapshot identity, navigation survival, explicit cancellation, history limits
  and background marker writes without overwriting newer content.
- `desktop/src/app/desktop-project-services.test.ts`: completion notifications,
  workspace-safe actions and background writes that cannot replace another Preview.
- `desktop/src/components/wiki-consistency-report-text.test.ts` and
  `desktop/src/lib/knowledge-report-settings.test.ts`: report localization,
  source preservation and matching schema/config defaults.

- `desktop/src/components/WikiConsistencyReport.test.ts`: structured report,
  independent disclosures, escaped model text and explicit session action.
- `desktop/src/lib/knowledge-citation.test.ts`, Preview evidence/navigation
  tests: current exact quotes, moved lines, stale/ambiguous evidence, source-map
  fallback, history, delayed reads and cleanup.
- `desktop/src/lib/knowledge-resolution.test.ts` and
  `desktop/src/app/knowledge-resolution.test.ts`: snapshot binding, task context,
  session activation, duplicate prevention and stale-startup cleanup.

Deterministic model callbacks verify orchestration and evidence validation;
they do not establish semantic accuracy. A separately reported actual-model
smoke should exercise direct and paraphrased conflicts, different environments,
explicit supersession and embedded prompt instructions using the configured
runtime. ACP build/typechecking and the existing Desktop checks remain
applicable. These verification targets do not claim that a live provider or
native macOS UI smoke has been run for every change.

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
