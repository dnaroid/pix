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
    "index": "index.md",
    "autoCheck": false
  }
}
```

All fields are optional. `path` is relative to the project; `index` is relative
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
- While the Wiki holds nothing but the untouched starter index (hidden entries
  and leading check reports ignored), the panel offers **Migrate docs to Wiki**.
  The explicit action starts a new agent session with the prompt from
  `desktop/src/lib/wiki-migration-prompt.ts`: inventory existing docs/specs,
  group them into sections with their own index pages, move them with `git mv`,
  fix every reference to the old paths, verify links and leave the changes
  uncommitted for review. The offer hides after a successful start and stays
  hidden once the Wiki has other pages.
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
  policy changes invalidate results. Visible tree rows load one directory at a
  time; saved consistency summaries use a separate bounded metadata traversal.
  Unopened descendants contribute to status summaries; expanding a folder loads
  its rows. Files and folders whose names start with `.` are hidden recursively
  and excluded from folder consistency summaries. Index pages are represented by
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
Manual and automatic checks share a project-owned queue. Waiting manual requests
take priority over waiting automatic requests; each priority retains FIFO order.
The queue and pre-save checks share one physical judge slot, including when an
aborted provider has not settled yet. Navigating to another page, closing Preview, changing editor
mode or hiding the Wiki panel does not cancel the task. The queue captures the
page text and its raw saved baseline when Check is pressed; later navigation
cannot substitute another page's text or save target. Identical active requests
are deduplicated. It holds up to 16 active tasks and the 32 most recent terminal
tasks in memory. Switching projects or disposing the workbench cancels and
clears this queue. Individual in-flight requests do not resume after an application
restart; an enabled automatic pass rediscovers its remaining versions from saved
checkpoints. Completed reports persisted inside their pages are restored when those pages reopen.

The Wiki sidebar's **Checks** disclosure shows queued/running tasks and retained
reports, including reports for an earlier document or draft snapshot. A
notification for a newly grounded conflict can reopen the page or reveal this
list. Clear, incomplete, failed and cancelled checks do not create completion
notifications. Reopening an unchanged page restores its
matching report and in-flight state. A report for changed text remains available
in the task list without being presented as a check of the new text. Explicit
Cancel stops a queued or running task; Dismiss removes a terminal entry.
Cancelling a request does not start the next request until the previous backend
promise settles. An already-started native atomic write cannot be recalled.

### Wiki Conflicts tab

Wiki Conflicts reviews conflicts and uncertainties from all saved page reports
of the selected project. The findings list lives in the Wiki sidebar panel,
which switches between **Pages** (search and tree) and **Conflicts** tabs; the
**Wiki Conflicts** auxiliary workbench tab shows only the comparison of the
selected finding at full width. It does not call the model or search when
opened; the only writes are user verdicts in existing report blocks (phases 1–2
of the [resolver proposal](../../proposals/wiki-conflict-resolver/index.md)).
One tab exists per window; reopening focuses it. Like other non-session tabs it
is not restored after an application restart. Filters and selection are shared
by the list and the tab, survive closing the tab, and are cleared by a project
switch, which also returns the sidebar to **Pages**.

- **Data.** One project-level background scan of saved reports feeds both the
  Wiki tree colors and this tab, and keeps running while the Wiki panel is
  closed. A completed queue check refreshes it immediately. The same finding
  reported by both pages (A↔B and B↔A) appears once; its identity ignores line
  numbers and line endings. A finding is **stale** when no current report still
  contains it. The list is capped at 2,000 findings.
- **Inbox (sidebar Conflicts tab).** Filters by kind (conflicts, uncertainties,
  within one page), status (open by default — includes findings awaiting a fix —, awaiting fix, decided, stale, all) and branch; groups
  by document pair or page. The Conflicts tab label shows the count of current
  findings. Each row has a checkbox to add/remove that finding from the batch
  basket; stale findings cannot be added, and unchecked boxes are disabled once
  the 50-finding limit is reached. The footer shows «Корзина: N находок · M
  страниц» (distinct side paths) and **Очистить** when the basket is nonempty.
  The basket is in-memory window state, not persisted; vanished/stale findings
  drop from it automatically, and project switch clears it. Selecting a row
  opens the comparison tab. The list is a single tab stop: j/k or arrows move
  between findings, `[`/`]` between groups, Home/End to the ends, Enter shows
  the comparison, and Space toggles the active finding's basket membership.
  The tree stays mounted while Conflicts is shown, so its expansion and header
  actions survive.
- **Comparison tab header** shows the summary, the position («N of M») with
  previous/next buttons, and **Show list**, which reveals the sidebar Conflicts
  tab. A basket bar shows the same count/page summary, **Разрулить в новой
  сессии** and **Очистить**; the comparison header also has a **В корзину / Убрать
  из корзины** toggle for the selected finding.
- **Comparison.** Both sides are read only when a finding is selected; a newer
  selection aborts older reads and drops late responses. Quotations are located
  in the current file text, not by saved line numbers, and rendered as Markdown
  with the Preview renderer (no raw source view): the quotation is expanded to
  whole blocks (a table, list, paragraph or fenced code block is never split)
  and highlighted, with about ±8 lines of whole neighbouring blocks dimmed and
  the nearest heading outside fenced code. When only part of a table is quoted,
  only the quoted rows are highlighted (the header counts as a row). Line
  numbers appear only in the source link and the highlight tooltip. Project
  links inside fragments resolve against the page and open in Preview. A missing or ambiguous quotation
  shows a **Text changed** banner with the saved quotation. Model prose is
  rendered as text. Labels follow the saved reports' language.
- **Side dates.** Each side can show its file creation date (oldest Git commit,
  following renames), latest file commit, and **Quote changed** date (latest
  blame commit for the raw-file quote lines). If quoted lines are uncommitted,
  their date uses file modification time and the side is marked **not
  committed**. Untracked or non-Git files show file modification time only. A
  **Newer** chip marks the side whose quote changed later when both dates are
  known and differ. Date lookup is supplementary: failures are logged as
  `wiki:conflicts-file-dates-failed` and dates remain unknown. The read-only
  `wiki_file_dates(workspace, path, startLine?, endLine?)` command validates
  workspace containment, uses literal Git pathspecs and bounds blame to 2,000
  lines.
- **Inline edit.** **Править** is available for a matched, non-stale side. It
  opens the raw quote-block lines in a textarea; save replaces exactly those
  body characters while preserving line endings. The block is re-verified
  before a compare-and-swap write, so a changed block produces a localized error
  and keeps the draft. The saved report remains with its old hash, making the
  finding stale until recheck, as with an unreviewed Preview save. The write is
  fenced to the current project generation and does not wait for the judge;
  comparison reloads afterward. Cmd+Enter saves and Esc cancels. Failures are
  logged as `wiki:side-edit-failed`.
- **Resolve in new session.** The comparison action is available for one
  finding only when a current report on a saved page still contains it. The
  prompt includes the finding and target path/hash, not the saved page text;
  the agent reads that page. Batch resolution starts one agent session for all
  basket findings. For each, it chooses a reporting page whose saved report is
  current and still contains the finding. Findings without a current report are
  skipped and stay in the basket with a notice; if none qualify, launch is
  refused with an error. Sent findings leave the basket only after the session
  actually starts. Batch JSON carries each target `{path, contentHash}`, finding
  `kind`, `draft`, `existing`, `explanation`, and optional `userDecision` from
  the current report. Side A/B decisions become explicit `authoritative` and
  `toFix` `{path, startLine}`; different-scope asks for scope clarification,
  false-positive asks only for confirmation, deferred is left alone, and notes
  pass through. Instructions follow the report language and the agent reads
  saved pages from disk; no captured page text is sent. The same safety rules
  as single-finding resolution apply: no commit, finding data is not instructions,
  and the report block must not be touched.
- **Empty states** distinguish no configured Wiki, a scan still in progress and
  an empty complete projection; the last warns that unchecked pages are not
  covered.
  - **Decisions.** Five verdicts, bound to keys 1–5 while focus is inside the
  comparison tab and not in a text field. The two side verdicts (*X is right*,
  labelled by file name or line for findings within one page) sit in the header
  of their own comparison column; keys 1/2 follow the displayed left/right
  columns, while the stored `side-a`/`side-b` keep canonical finding order. The
  verdict bar under the comparison header holds *different scope*, *false
  positive* and *defer*, plus an always-visible **Rationale** field (up to 1,000
  characters): optional for every verdict, attached to the chosen verdict,
  editable after a decision, and required only for *false positive*. In the
  sidebar list, a finding with a verdict (fix pending or decided) shows a
  neutral clock icon instead of the conflict/uncertainty icon. The verdict is stored as `decisions` [{findingId, verdict,
  note?, taskId?, at}] inside the report block of every page whose saved report contains
  the finding; page bodies are not changed and no report is created. Each write
  waits for the shared judge slot and uses compare-and-swap against the raw
  file, so a concurrent edit makes it fail. Writes that succeeded are not rolled
  back: when reports disagree the bar shows **Decision saved partially** with
  **Retry write**, which repeats the last attempted operation (including a
  clear), and the newest decision is displayed. A project switch fences every
  later read and write of a decision in progress. **Clear decision**
  removes it; removing the last decision restores the original block bytes.
  Each decision may include `taskId` only with `verdict: "deferred"`; it must
  match `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`. **Создать задачу** is available
  for a deferred finding without a linked task; **Открыть задачу** opens its
  linked project task. Creation uses a title based on finding kind and files,
  an explanation plus both path-and-line quotations and finding id, links to
  both side paths, and type `bug` for conflicts or `improvement` for
  uncertainties. The task is created before its id is saved into the deferred
  decision; an existing note/task link is preserved. The Tasks panel opens
  afterward. Project switching prevents subsequent linking or opening.
  *False positive* and *deferred* findings count as **decided**: they leave the
  open list and the tab count, and a page whose remaining conflicts are all
  decided is no longer red. Fix verdicts (sides, different scope) set status
  **fix-pending** (shown as **Awaiting fix**): it still counts as open and
  keeps the page red. The **open** filter includes fix-pending findings.
  When a current report checked after the decision still contains the finding,
  it shows **Recheck still finds the contradiction** and returns to plain open
  (the verdict is kept; choosing it again makes it pending until the next
  check). A recheck that no longer reports it drops the finding and decision.
  Every successful change shows an 8-second **Undo** notification that restores
  the previous decision with its original timestamp under the same project
  fence. A new check of the page
  carries decisions over for findings it reports again and drops the rest.
  Decisions survive body edits that keep the report. Older app versions do not
  understand report blocks with decisions and treat them as absent.
- **Recheck** queues an ordinary manual check of each reporting page's saved
  body through the shared queue (this calls the model). Pages already queued,
  running or being read are skipped, so repeated clicks add no duplicates.

Entry points: the sidebar **Conflicts** tab, **Review**
(«Разобрать») in the conflict notification (single page → branch filter), the
**Open in Wiki Conflicts** report action, and **Review contradictions**
(«Разобрать противоречия») in the native context menu of red Wiki tree rows,
which filters to that row's path. Other tree rows keep the window context menu.
Every entry point except the sidebar tab itself reveals the Wiki sidebar panel
on its Conflicts tab and focuses the comparison tab; a request with a path or
finding replaces the branch filter, a bare open keeps the current view.

### Background automatic checks

The Wiki header has **Проверять в фоне** (Check in background), off by default.
It persists `wiki.autoCheck` in `.pi/workspace.jsonc` using the existing serialized,
locked compare-and-swap writer, preserving comments and unrelated settings.
Enabling starts a new pass and also stores `wiki.autoCheckRunId`, a managed UUID.
An externally enabled setting without an ID receives one before work is queued.
The saved choice remains visible even if subsequent source-policy or Wiki-path
validation fails; a failed write never optimistically enables the checkbox.

The owner belongs to the open project, independently of the Wiki panel or Preview.
It checks non-green saved Markdown versions throughout the configured Wiki:
unreviewed pages, changed hashes, and existing red/yellow results. Valid green
versions are skipped as tasks but remain eligible evidence for other pages.
The automatic owner does not save unsaved editor text or change search sources,
providers or models. Disabled Knowledge indexing pauses the pass until that source
is enabled through its existing control. Queuing waits for the ACP connection to
be ready. The header shows processed/total and pending work; errors remain inline
and in diagnostic logs instead of producing completion notifications.

The configuration and Wiki filesystem metadata are polled every five seconds.
While disabled, only configuration is polled. Native directory inventory runs
on blocking workers, without reading Markdown bodies. It streams bounded pages
of at most 128 returned/512 inspected entries and about 25 ms of work; the frontend
processes at most four pages and four file reads per work slice. Changed/new files
settle for 750 ms before reading. A file revision includes size, timestamps and
native file identity, so same-size atomic replacements are detected. Directory
cursors are fenced by every ancestor's identity, not timestamps changed by sibling
report writes. Hidden/generated entries and symlinks are excluded, and a later
read independently validates the Wiki path, ancestors, file identity and byte
limit. Native cursors are released after cancellation and late replies, and are
bounded and expiring even if a caller disappears.

The automatic owner keeps bounded metadata, hashes and incremental work sets,
not all document bodies. At most one automatic job occupies the shared queue,
leaving capacity and priority for manual requests. Identical active manual and
automatic snapshots share one job. Every completed non-green version receives
a small `pix:wiki-check` footer with `status: "attempted"`, its body hash and pass
ID and the supported document-size budget. This is a checkpoint, never a green consistency mark. A failed model request
retains the previous full report and its original hash while recording the new
attempt. Manual saved checks can satisfy the currently enabled automatic pass.

The same pass does not repeatedly send an unchanged red, yellow or failed version
to the model, including after restarting the app. Editing its logical body makes
it eligible again; rewriting only report/check metadata does not. New and renamed
files are discovered without opening their folders. After a checker budget increase,
a page skipped under the older size budget is eligible once under the new budget;
an unchanged supported page still resumes its checkpoint. A new explicit off/on cycle
starts a new pass over the remaining non-green versions. Clear results remove
the report/checkpoint and leave the usual green footer. Failed metadata writes
retain the result in the queue; newer disk contents are never overwritten.

Disabling immediately invalidates pending inventory and removes only waiting
automatic jobs. An already-running check can finish and save in its original
Wiki, while manual jobs continue. Changing the configured Wiki root prevents a
late automatic write outside the new Wiki. Project replacement invalidates all
owners and cancels their requests; final disposal releases timers, cursors and
pending ownership. Oversized/unreadable files produce a bounded inline diagnostic
without a model request. The inventory supports up to 50,000 files and reports its
limit without claiming exhaustive completion; later smaller inventories recover.

Only completed `conflicts` results containing grounded findings produce a red
notification. Several newly conflicting pages in a pass update one notification.
Deduplication compares the body hash and paired source paths/quotations, including
the report already stored in the file; a paraphrased explanation or repeated
unchanged result does not notify again. Notification actions retain their project
and generation, so they cannot navigate a replacement project's workbench.

### Shared checking and save behavior

Pre-save checks keep their editor/draft ownership and cancellation rules; a
background manual result never authorizes saving an edited draft. A saved-page
background result can update its original file's footer only through the raw
expected-content guard. If recording fails or the file has changed, the report
is retained with a recording notice and the new file is not overwritten.
App-owned report/checkpoint writes share the judge slot so they cannot invalidate
another comparison's raw evidence snapshot while that model request is active.
A failed explicit recheck preserves an unchanged page's existing green stamp.

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
It uses the independent `knowledgeCheck.modelRef` and `knowledgeCheck.thinking`
preferences, never the Search answer model or session default. Each nonempty
user-global Desktop field overrides the corresponding user-global Tools Suite
field; empty or omitted Desktop fields inherit Suite. Reasoning defaults to
`low`; a model must be selected explicitly. Invalid settings or an unavailable
judge produce an error, not a fallback to another provider. Model references use
`provider/model` without a thinking suffix. Project config cannot override the
judge. Preferences are captured at the start of each check; an in-flight check
keeps its selected model. Validation of model preferences precedes retrieval.
Judge selection and reasoning are managed in the model setup wizard under
**Features → Assistant**, with shared Suite and optional Desktop-override slots.
Settings show the saved values read-only with **Edit in wizard…**; report
language remains an ordinary editable setting. Opening/cancelling the wizard
does not change a judge, restart completed checks or invalidate existing stamps.
The normal provider runtime, credentials and extension loading are reused.
It creates no conversation. Drafts, sources and their metadata are
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
| Logical document | 128,000 characters |
| Draft in one comparison | 48,000 characters; at most 3 lossless document parts |
| Related-document retrieval | Up to 8 queries within a shared 45-second budget per part |
| External evidence | Up to 12 source pages and 48,000 characters including context per part |
| Source excerpts | Matched line ranges are reserved first; remaining context is shared across selected pages within the total evidence budget |
| Comparisons | One Wiki comparison per part, plus every distinct pair of parts; at most 6 model calls |
| Whole check | 120 seconds per planned comparison, including retrieval; each model call retains its 120-second limit |

Documents above 48,000 characters remain one queue job and one saved result.
The checker prefers paragraph, line or word boundaries, retains all original
text, and never divides a CRLF or UTF-16 surrogate pair. Each part is compared
with its own retrieved Wiki passages; every pair of parts is also compared so
claims in distant parts can contradict each other. Bounded document-head and
preceding context help interpret later parts without serving as quotation evidence.
The result retains the full logical document SHA-256 and original line numbers,
including citations to two different parts of the same document.

The report shows completed/total parts and comparisons. Every planned comparison
and every original snapshot must validate before the document can be green.
A failed later comparison retains already grounded findings with an incomplete
scope; cancellation still discards the operation. Merging deduplicates findings
and keeps the existing 20-conflict/10-uncertainty bounds. The saved report retains
at most 12 original passages and 48,000 passage characters; if this is a subset,
it explicitly distinguishes retained passages from all compared passages.
Display sampling alone does not invalidate a completed comparison. The merge
also enforces the actual escaped 384 KiB report envelope by omitting whole
passages/findings with notices, never by rewriting quotations. Dropped findings
cannot yield a green result, and an established retained conflict stays red.

Queries sample representative sections when the draft exceeds the query budget.
Source passages retain bounded leading context for lifecycle and scope metadata.
Ordinary query sampling, top-candidate/source limits, excerpts and context
reduction describe the review scope in a compact coverage summary. They do not
make a successfully completed comparison of the selected passages incomplete.
Passages and leading context end on complete lines; optional context never
displaces the reserved matched range. Timeouts, failed or stale retrieval,
unavailable/incomplete semantics, unreadable sources and genuine comparison
uncertainty still produce notices and prevent a clear result. A partially built
semantic index reports its latest `indexed/total` coverage once and points to
Knowledge indexing in **Search indexes**; the check itself never starts a full
indexing run. Sources
are reread from validated project files; cached search snippets are not used as
proof. The model can also compare two claims within the draft. With zero external
evidence, internal findings remain available, but cross-document consistency
cannot be established.

Findings require known source IDs and exact, uniquely occurring quotations in
the draft and source passage after newline normalization. A quotation absent
verbatim is retried once with whitespace runs (line breaks, indentation, repeated
spaces) treated as equivalent, because judges often re-wrap hard-wrapped Markdown;
it must still occur exactly once, and the citation keeps the exact original slice,
never the model's text. Diagnostics distinguish a missing from a repeated
quotation. Line ranges are computed from those texts. Metadata context alone cannot ground a quote.
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
in that report's project and submits the report's actionable data — status,
conflicts, uncertainties and notices — with the exact captured document text,
bound to its SHA-256. Retrieval statistics, the judge model and reviewed
passages without findings are not handed off. The Wiki Conflicts comparison
offers the same action for one finding: it requires a current report on a saved
page, submits only that finding and the target path/hash, and lets the agent
read the saved file instead of embedding its text. Opening, expanding or completing a report
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

Before returning a result, the service revalidates the Wiki corpus, Wiki
configuration, the raw hash of the draft's saved baseline and the evidence text
of selected source files. The corpus fence compares every Markdown page's body
without app-owned report/stamp metadata (cached by unchanged file metadata), and
selected sources compare their line-preserving evidence text. Body edits,
additions, removals and renames, including of previously unselected pages,
invalidate the result. A report or decision written to another page (for example
by a `wiki_conflicts` recheck from a session), a `touch` or an identical atomic
rewrite does not. Pages unreadable as evidence fall back to file metadata.
Incomplete corpus validation also prevents a clear result.
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
markers and changed text do not earn a green mark. A page with a current saved
conflict report is red only when its body hash and report/draft paths match the
current page. Incomplete, stale, malformed and attempted results are neutral.

Wiki folder icons and names, including the synthetic root row, summarize all
Markdown descendants independently of expansion. Red has priority when any
descendant has a current conflict. A folder is green only after complete
discovery, with at least one document and every descendant green; otherwise it
retains its normal color. Empty folders and image/asset-only folders are neutral.
A page whose current report has conflicts, all decided as false positive or
deferred, is not red; its row and every ancestor folder row show a muted
pause icon (`data-wiki-accepted`), and the tooltip/accessible description
names the accepted count. The marker never changes the green/red/neutral
status and is dropped once the report is stale or the page turns red again.
`index.md` and custom index pages count even when their file rows are hidden.
Tooltips and accessible descriptions include recursive document counts and the
reason for the color, including an unreviewed existing index page, so color is
not the only status indicator.

The mounted tree owns a bounded metadata/status cache for up to 50,000 files.
Its initial scan discovers collapsed descendants and reads saved marks/reports;
later scans read bodies only for new or changed native file revisions. Revision
identity includes size, timestamps, device and inode, including same-size atomic
replacements. A changed file becomes unknown immediately on discovery, before
its new metadata is validated. Aggregate counts update only the file's ancestor
chain; rendering a row uses a cached lookup, without recursive disk reads.
Deleted and renamed entries are pruned after authoritative discovery. No document
bodies are retained in the cache, and no sidecar or folder metadata is written.

The existing foreground tree refresh starts a status pass every five seconds.
Status work uses the paginated native inventory on blocking workers, at most four
pages and four document reads per 50 ms work slice, with a 750 ms edit-settling
delay. Status-specific inventory excludes dot-prefixed files and folders, matching
the visible tree; non-hidden generated Markdown still counts when visible.
Automatic model-check eligibility remains unchanged. Symlinks,
paths outside the Wiki, Git metadata and private disposable paths remain refused.
The bounded reader accepts the draft budget plus report/footer overhead. Unreadable
or oversized documents remain unknown. Completeness is tracked per branch:
an inaccessible directory prevents green for that branch and its ancestors,
while independent fully discovered branches can become green. Cached red
descendants are not pruned merely because their directory was inaccessible.
An inventory limit cannot grant a green folder. A later successful pass recovers.
Project/Wiki replacement and unmount abort old owners, release cursors and cancel
owned timers; late reads cannot repaint a new tree. No search or model request is
made to display file or folder colors, including when automatic checks are off.

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
- `desktop/src/components/wiki-consistency-tree-state.svelte.ts`
- `desktop/src/lib/wiki-consistency-tree.ts`
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
- `desktop/src/app/knowledge-judge-gate.ts`
- `desktop/src/app/wiki-auto-check.svelte.ts`
- `desktop/src/app/wiki-auto-check-settings.svelte.ts`
- `desktop/src/app/wiki-conflict-notifications.ts`
- `desktop/src/lib/wiki-auto-check-config.ts`
- `desktop/src/lib/wiki-check-inventory.ts`
- `desktop/src/components/WikiAutoCheckControl.svelte`
- `desktop/src/components/ProjectWikiCheckQueue.svelte`
- Wiki Conflicts tab: `desktop/src/lib/wiki-conflicts-index.ts`,
  `desktop/src/app/wiki-finding-decision.ts`,
  `desktop/src/app/wiki-finding-decision.test.ts`,
  `desktop/src/app/wiki-finding-resolution.ts`,
  `desktop/src/app/wiki-finding-resolution.test.ts`,
  `desktop/src/lib/wiki-citation-context.ts`,
  `desktop/src/lib/wiki-conflicts-navigation.ts`,
  `desktop/src/lib/wiki-tree-menu.ts`,
  `desktop/src/app/wiki-consistency-owner.svelte.ts`,
  `desktop/src/app/workbench-wiki-conflicts.svelte.ts`,
  `desktop/src/app/wiki-conflicts-inbox.svelte.ts`,
  `desktop/src/app/wiki-conflict-compare.svelte.ts`,
  `desktop/src/app/wiki-conflicts-recheck.svelte.ts`,
  `desktop/src/components/WikiConflictsTab.svelte`,
  `desktop/src/components/WikiConflictsList.svelte`,
  `desktop/src/components/WikiConflictDecisionBar.svelte`,
  `desktop/src/components/wiki-conflicts-text.ts`,
  `desktop/src/components/ProjectWikiPanel.svelte`,
  `desktop/src/components/WikiConflictCompare.svelte`,
  `desktop/src/components/wiki-conflicts-text.ts`,
  `desktop/src/lib/wiki-file-dates.ts`, `desktop/src/lib/wiki-file-dates.test.ts`,
  `desktop/src/lib/wiki-citation-context.ts`,
  `desktop/src/lib/wiki-citation-context.test.ts`,
  `desktop/src/lib/wiki-side-edit.ts`, `desktop/src/lib/wiki-side-edit.test.ts`,
  `desktop/src/app/wiki-side-edit.ts`, `desktop/src/app/wiki-side-edit.test.ts`,
  `desktop/src/app/wiki-finding-task.ts`, `desktop/src/app/wiki-finding-task.test.ts`,
  `desktop/src-tauri/src/wiki_file_dates.rs`
- `acp/src/knowledge/contract.ts` and `acp/src/knowledge/request.ts`
- `acp/src/knowledge/evidence.ts` and `acp/src/knowledge/native-search.ts`
- `acp/src/knowledge/comparison.ts` and `acp/src/knowledge/service.ts`
- `acp/src/knowledge/chunks.ts` and `acp/src/knowledge/chunk-report.ts`
- `acp/src/knowledge/preferences.ts` and `acp/src/knowledge/report-language.ts`
- `acp/src/knowledge/stamp.ts`
- `acp/src/acp/pix-acp-agent.ts` (Desktop check RPC)
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/lib/markdown-context.ts`
- `desktop/src/lib/markdown-links.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/wiki_consistency.rs`
- `desktop/src-tauri/src/wiki_check_inventory.rs`
- `src/schemas/workspace-schema.ts` and generated `schemas/workspace.json`

## Verification

Contradiction-check verification uses the following focused targets:

- `acp/test/knowledge-comparison.test.ts`: structured model-output validation,
  exact quote provenance, derived line ranges, internal conflicts and cancellation.
- `acp/test/knowledge-chunks.test.ts`: lossless bounded splitting, full-document
  hashes/baselines, original citation lines, cross-part conflicts, partial failures,
  cancellation, all-snapshot freshness and bounded merged report persistence.
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
- `desktop/src/app/wiki-auto-check.test.ts`: bounded discovery and backpressure,
  hash/pass deduplication, external changes, incremental inventory limits,
  source readiness, project replacement, cancellation and late cursor cleanup.
- `desktop/src/app/project-auto-knowledge-check.test.ts` and
  `desktop/src/app/knowledge-judge-gate.test.ts`: actual store/queue integration,
  model serialization, raw guarded checkpoints, restart, failed rechecks and
  metadata writes that wait for active comparisons.
- `desktop/src/app/wiki-auto-check-settings.test.ts`,
  `desktop/src/lib/wiki-auto-check-config.test.ts` and
  `desktop/src/components/WikiAutoCheckControl.test.ts`: JSONC preservation,
  explicit toggles, pass initialization, stale owners and saved checkbox state.
- `desktop/src/app/wiki-conflict-notifications.test.ts`: grounded-conflict-only
  notifications, aggregation, persisted evidence deduplication and safe actions.
- `acp/test/knowledge-auto-check-stamp.test.ts`: bounded attempted checkpoints,
  logical body hashes, retained report bytes and separation from green stamps.
- `desktop/src/lib/wiki-check-inventory.test.ts` and native
  `wiki_check_inventory` tests: IPC cancellation, bounded pagination, cursor
  ownership/expiry, symlink exclusion, replacement fences and strict reads.
- `desktop/src/lib/wiki-consistency-tree.test.ts`: current saved-result parsing,
  stale/renamed reports, recursive red priority, complete green coverage,
  index-page counts and incremental deletion/replacement.
- `desktop/src/components/wiki-consistency-tree-state.test.ts`: cached refreshes,
  changed-file invalidation, collapsed descendants, partial/capped inventories,
  independent-branch recovery, retained red under failed branches, dot filtering,
  stale owners, cursor cleanup and teardown.
- `desktop/src/lib/wiki-status-inventory.test.ts` and native status-inventory
  tests: visible tree-only inventory with unchanged automatic-check eligibility,
  hidden-path exclusion, mode-bound cursors and preserved containment/read guards.
- `desktop/src/components/wiki-consistency-report-text.test.ts` and
  `desktop/src/lib/knowledge-report-settings.test.ts`: report localization,
  source preservation and matching schema/config defaults.

- `desktop/src/components/WikiConsistencyReport.test.ts`: structured report,
  independent disclosures, escaped model text and explicit session action.
- Wiki Conflicts tab: `desktop/src/lib/wiki-conflicts-index.test.ts` (identity,
  merge, stale, filters), `wiki-citation-context.test.ts`,
  `wiki-conflicts-navigation.test.ts`, `wiki-tree-menu.test.ts`,
  `desktop/src/app/wiki-consistency-owner.test.ts`,
  `wiki-conflict-compare.test.ts` (fast-switch race, abort, dispose),
  `wiki-conflicts-recheck.test.ts` (no duplicate queueing, project switch),
  `workbench-wiki-conflicts.test.ts` (shared inbox requests, sidebar view,
  close vs project reset) and
  `desktop/src/components/WikiConflictsTab.test.ts` (SSR render of the sidebar
  list and the comparison-only tab: empty states, default selection, position,
  requests, escaping). SSR renders do not run effects; no native macOS UI smoke
  has been run for this layout.
- Conflict side-date and edit/task tests: `desktop/src/lib/wiki-file-dates.test.ts`,
  `desktop/src/lib/wiki-citation-context.test.ts`,
  `desktop/src/lib/wiki-side-edit.test.ts`, `desktop/src/app/wiki-side-edit.test.ts`,
  and `desktop/src/app/wiki-finding-task.test.ts`; native `wiki_file_dates` tests
  cover Git metadata and bounded blame. `acp/test/knowledge-decisions.test.ts`
  covers decision validation and task links.
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

## Agent tool `wiki_conflicts`

ACP RPC sessions load `acp/dist/extensions/wiki-conflicts.js` (source
`acp/src/extensions/wiki-conflicts.ts`, path set in `acp/src/main.ts`). The tool
is registered inactive and activated per run in `before_agent_start` only when
the project Wiki is initialized (`.pi/workspace.jsonc` config, default
`wiki/index.md`, with an existing index file); otherwise it is removed from the
active tools. It scans saved `pix:wiki-report` lines in Wiki Markdown pages
(at most 5,000 pages, symlinks and dot entries skipped) through the same
projection as the Conflicts tab (`acp/src/knowledge/findings.ts`). Actions
(`acp/src/extensions/wiki-conflicts-actions.ts`):

- `list` (default): `status` (`open` default, includes fix-pending;
  `fix-pending`, `decided`, `stale`, `all`), `kind` (`conflict`,
  `uncertainty`, `internal`), `path` prefix, `ids` (full id or hex prefix of at
  least 8 characters, up to 50; status defaults to all), `limit` 1–200
  (default 30). Returns totals, sides `a`/`b` in canonical order (the same
  order as verdicts `side-a`/`side-b`), explanation, status, decision and
  `quoteChanged` — sides whose quote (whitespace-normalized, metadata
  stripped) no longer occurs in the current page or whose page is unreadable.
- `decide`: `id` (unique prefix allowed), `verdict` (`side-a`, `side-b`,
  `different-scope`, `false-positive` with required `note`, `deferred`, or
  `clear` to remove the decision), optional `note`. It writes the verdict to
  every report containing the finding through the shared
  `acp/src/knowledge/finding-decision.ts` (also used by the Conflicts tab); a
  linked task is kept while the finding stays deferred. Guidance: fix
  verdicts only after the fix is written; false-positive/deferred only on the
  user's explicit decision.
- `recheck`: `path` of one page inside the Wiki folder. Runs the same
  `KnowledgeCheckService` as Desktop's explicit check (configured judge model —
  a paid call — and native search; the ACP host passes the bundled suite via
  `PIX_WIKI_CHECK_TOOLS_SUITE_EXTENSION`), records the result with
  `recordKnowledgeCheck` and returns counts and the page's findings. If the page
  changed during the check, the report is not saved (`saved: false`).

Writes (`acp/src/knowledge/wiki-page-files.ts`) are compare-and-swap: the page
is re-read before and after writing a same-directory temporary file, which is
then renamed over the page; symlinks, hidden/parent segments and oversized
files are rejected.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"1ca56dcbd5eb69ec7c9a7089d1521b0de11d7f40ceaee054f61fb8f0fd023fa2","checkedAt":"2026-10-31T02:07:11.576Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":22,"candidateSources":103,"reportLanguage":"ru"} -->
