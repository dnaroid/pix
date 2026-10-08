---
kind: spec
status: active
---

# Desktop workspace keyboard navigation

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Make Pix Desktop workspace navigation behave like an IDE navigator: the Activity
Bar and Project Explorer are keyboard-first composite controls with stable focus,
while project selection/open state remains separate from transient focus.
Desktop product support is macOS only; retained Windows/Linux branches do not
establish compatibility requirements.

## Project Explorer behavior

- Reverse navigation opens Files without changing the workspace root: clicking
  a validated relative directory link or choosing **Show in Files** on a Preview
  editor tab clears the Files search, expands the root and ancestors, selects the
  target, and scrolls/focuses its row. Directory targets also expand. This does
  not open a file, change the active workbench tab, or save/discard an editor draft.
  Only the required lazy branch is loaded; missing/unsafe targets are not invented.
  Replacement reveals, workspace changes, teardown and changed tree-focus intent
  cancel stale asynchronous completion. Paths outside the project have no tab
  reveal action. See [decision 0058](../docs/decisions/0058-reverse-file-navigation.md).
- The tree starts with an explicit workspace-root directory row named after the
  project folder. It is expanded on mount and workspace change; refresh and search
  preserve its current state. Its children are one level deeper. Click,
  Enter/Space and Left/Right toggle/navigate it like other directories. Collapsing
  the root clears all descendant expansion preferences but keeps selected files intact;
  the root participates in the same single roving Tab stop.
- Collapsing any directory clears its own and all descendant expanded-directory
  paths, including hidden descendants, and persists the reduced list. Reopening
  shows its immediate children collapsed; sibling branches, cached listings and
  selected files remain unchanged.
- Right-click or Context Menu / `Shift+F10` on the root offers New File/New Folder
  and Paste in the project root, plus external-editor and file-manager commands,
  without requiring empty space below the file list. The root cannot be renamed,
  deleted, copied, duplicated or dragged. It remains reachable in empty, loading
  and failed-listing states. Root collapse is transient and is not stored among
  relative expanded-directory paths; successful create/paste expands its target.
- The visible project hierarchy is exposed as one ARIA `tree` containing
  `treeitem` rows with `aria-level`; directory rows additionally expose
  `aria-expanded`.
- Exactly one visible tree row participates in the normal Tab sequence. The
  current focused row wins, then the selected/open file when visible, then the
  first visible row.
- ArrowUp/ArrowDown move focus across visible rows without wrapping. Home/End move
  to the visible bounds. Keyboard movement scrolls the focused row into view.
- ArrowRight expands a collapsed directory. On an already expanded directory it
  moves to the first visible child when one exists.
- ArrowLeft collapses an expanded directory. Otherwise it moves to the nearest
  visible parent row; a root item remains in place.
- Enter/Space open files or toggle directories. Printable-key type-ahead uses a
  short accumulated query and wraps to the next visible matching entry name.
- Opening a file updates persistent selected-file styling; moving focus alone
  never changes that selection.
- Row hover background follows only the pointer, not DOM focus. Restoring focus
  after deletion must not leave a second hover-like filled row when the pointer
  moves elsewhere. Keyboard focus remains visible through the inset focus ring,
  separately from persistent selected/open-file styling.
- Refreshing project files updates the root and currently visible expanded
  directories in place. It preserves expanded directories, the selected file,
  focus state, and existing rows while refresh requests are in flight. When the
  workspace changes, selection/focus and loaded directory contents reset, but
  that project's folder expansion state is restored from
  `.pi/workspace.jsonc` under `projectExplorer.expandedDirectories`. Only
  relative expanded-directory paths are stored; directory contents are never
  persisted. The list is bounded to 256 paths, writes are debounced and
  serialized, and conditional workspace-config writes retry concurrent edits
  while preserving comments and unrelated settings. Stale branches are pruned
  as their nearest loaded parent is enumerated, so restoring state does not
  trigger an unbounded filesystem walk.
- `Shift+Enter` opens the focused file or directory in the configured external
  editor. Gram is a supported built-in choice. When no external editor is
  configured, Desktop reports that the user must choose one in Desktop Settings
  rather than silently assuming Zed. The external-editor icon is visible only on
  the pointer-hovered row, disappearing immediately when the pointer leaves;
  retained DOM focus or selected-file state must not leave another icon visible.
  It is removed from the normal Tab sequence so every tree row does not add a
  second Tab stop.
- On macOS, Gram targets are opened through Gram's bundled CLI when it is present
  inside the installed app bundle; LaunchServices app opening remains the fallback.
  This keeps file/project opening aligned with Gram's own command-line entry point
  even when the `gram` executable is not installed on `PATH`.
- Project entries expose IDE-style contextual file commands without adding a Tab
  stop per row. Right-click, the Context Menu key, and `Shift+F10` open the same
  command surface for the focused row. The command set includes Open/Open in
  External Editor, New File/New Folder for directory targets, Copy/Paste,
  Duplicate, Rename, Copy Relative Path, Copy Absolute Path, and Delete where applicable.
  Both path commands apply to files and folders below the workspace root and copy
  plain filesystem text without quoting or URI escaping. Absolute paths include
  the active workspace root; relative paths retain the existing project-relative form.
- HTML files (`.html` and `.htm`, case-insensitive) additionally offer **Open in
  Browser** in both menu surfaces. On macOS this opens the saved file in the
  default HTTPS browser, regardless of the HTML file's editor association, without
  saving drafts or starting a web server. Other files, folders and the root omit
  the action. The backend rejects missing, non-HTML, symlink and escaped targets;
  failures use the Files error surface and stale failures cannot affect a replaced
  workspace or disposed panel.
- In the Tauri Desktop host, Project Explorer uses an OS-native context menu.
  On supported macOS Desktop it may extend beyond the application window; the
  OS owns placement, screen-edge clamping and keyboard traversal. Pointer menus
  use the click position and keyboard menus anchor below the focused row. The
  invoking row keeps focus. Clipboard and Git-ignore eligibility are awaited
  before popup and captured for that opening; background Git refreshes do not
  change an already-presented native menu. Paste still rereads at activation.
  Replacement, workspace change and disposal invalidate callbacks and release
  native resources; intervening interactions cancel pending preparation/IPC.
  Popup promise resolution is not treated as a portable dismissal signal.
  See [decision 0028](../docs/decisions/0028-native-explorer-context-menu.md).
- The standalone browser preview retains the DOM menu, bounded inside its
  viewport with an 8 px inset using rendered dimensions. It repositions on
  content changes, scrolls internally if needed and dismisses on window resize.
- The same context menu reveals the targeted file or folder in the OS file manager,
  or opens the project folder for the root context menu. On supported macOS
  Desktop the label is **Reveal in Finder**, and Finder selects the targeted
  entry. The native command validates the target
  against the workspace and rejects symlink targets or escaped paths.
- `F2` renames the focused entry, `Delete` requests deletion, and the platform
  primary Copy/Paste shortcuts operate on the Project Explorer entry clipboard
  while tree focus is active. These shortcuts do not replace normal text-editing
  shortcuts outside the tree.
- Copy writes a versioned Pix file/folder reference (source workspace, relative
  path and kind) to the system text clipboard. Paste works across project windows
  and independently running Pix instances on the same macOS machine, including
  after changing projects or closing the source window. It copies the current
  source contents at paste time, not a snapshot; deleted/inaccessible sources
  report an operation error. Finder file clipboard interoperability is not part
  of this format. Ordinary text, path-only Copy commands and invalid references
  do not count as copied entries and never fall back to a stale local reference.
  Clipboard reads occur only on opening a file menu and on Paste, not by polling;
  Paste rereads the clipboard before issuing the mutation. Late menu reads and
  operation completions cannot affect a replaced workspace or disposed panel.
  See [decision 0026](../docs/decisions/0026-cross-instance-file-clipboard.md).
- File mutations are workspace-relative backend operations. They reject paths
  that escape the active project and do not follow symbolic links. Copying a
  project entry creates a non-conflicting destination name rather than silently
  overwriting an existing file or directory. Cross-project Paste validates source
  paths relative to the source workspace and destination paths relative to the
  receiving workspace, checks canonical paths to reject copying a folder into
  itself/descendants even through different workspace roots, and runs recursive
  copying off the UI thread. Exclusive creation prevents overwrite or deletion
  of a target claimed concurrently by another instance; a collision race reports
  an error and can be retried. Partial copies owned by the operation are cleaned
  up after a copy failure, including encountering a nested symbolic link.
- Rename, copy/paste, duplicate, create, and delete refresh only the affected
  directory state. Rename preserves focus/selection and expanded descendants
  under the new path when possible and updates the workspace-config expansion paths;
  deletion moves focus to a logical surviving row and clears stale
  selected/expanded state beneath the removed path from both memory and the
  sparse persisted preference.
- Delete is destructive and requires confirmation before the filesystem mutation.
- Pending file I/O does not globally disable Files commands. Deletion/rename
  reserve the affected subtrees; creation keeps its parent directory alive and
  reserves the new path, allowing independent sibling mutations. Copy/paste and
  duplicate conservatively reserve the destination subtree because the backend
  chooses the output name (including partially visible copies). Copying into the
  workspace root therefore excludes other mutations in that root while it runs;
  navigation, opening files and clipboard-reference/path commands remain usable.
  Ignore operations protect the target and possible ancestor `.gitignore` files.
  Conflict checks apply both to menu availability and action activation.
  Files shows active operation labels/counts without a modal progress window.
  Create/rename dialogs close after submission, before filesystem I/O; failures
  appear in the Files error surface. Each operation owns its completion token;
  finishing one cannot unlock or invalidate another, and workspace replacement
  or panel teardown invalidates all old completions. Late deletion completion
  does not restore tree focus after the user has moved to another row.
  See [decision 0028](../docs/decisions/0028-scoped-file-operation-reservations.md).
- File/folder context menus expose **Add to .gitignore** only after a local Git
  check confirms an exact workspace-root repository and a target not already
  matching ignore rules, including tracked files and folders with tracked
  descendants. Ignore matching is checked independently of the index. The backend
  rechecks eligibility before writing; it never removes anything from the index,
  so already tracked files retain their Git status after a rule is added. It appends
  an anchored, escaped literal rule, with a trailing slash for folders, to the
  nearest existing ancestor `.gitignore`, or creates the root `.gitignore`.
  Existing rules/comments and newline style are preserved. Workspace escapes,
  symlinks and Git metadata are rejected. Completion refreshes directory listings
  and the shared Git snapshot, updating target/ancestor/`.gitignore` colors without
  manual refresh. Menu checks and mutation completions cannot affect a replaced
  workspace or closed menu/panel. Rechecking the same menu target after a Git
  snapshot refresh preserves its confirmed eligibility while the read is pending,
  so polling does not make the action blink. A fresh ineligible result or failed
  check hides it; changing targets clears the previous target's eligibility.
- Existing pointer drag/drop behavior and lazy directory loading remain unchanged.
- Project Explorer keeps dotfiles and dotfolders in the normal tree. Entries whose basename starts with `.` use muted opacity by default so ordinary source files retain visual priority; hover, keyboard focus, and selected/open state restore normal readability.
- Project Explorer colors changed file names from the shared workspace Git snapshot, without displaying status letters or badges. Added/untracked files use success, deleted files warning, conflicts error, and other changes info semantic colors. Working-tree status takes color precedence over staged status; tooltips and accessible row labels describe both scopes. Existing folders containing changed descendants use info-colored names, even when collapsed, with conflicts taking error-color priority. Renames color both source and destination ancestor folders; absent/deleted files are not invented in the filesystem tree. Clean files and unavailable/non-repository snapshots have no decorations.
- While Files is mounted, local Git status refreshes on opening/workspace change, Files Refresh, window focus, file-operation completion, and about every five seconds after the previous read completes. Reads are serialized and repeated triggers coalesce; closing the panel stops scheduling. This reuses the workspace-guarded Git store and does not fetch remotes or traverse/expand the lazy tree. Git errors do not prevent file browsing or change its health indicator.
- While Files is mounted and the window is focused and visible, directory listings
  refresh about every five seconds after the previous poll completes and immediately
  when returning to the window. Only the root and visible expanded directories are
  read, without recursively scanning the project or adding a filesystem watcher.
  Polling preserves existing rows, expansion, selection and focus, skips directories
  already loading, and uses the tree's generation/request guards against stale
  workspace or mutation completions. Background/hidden windows stop scheduling;
  closing Files removes timers and activity listeners. Search results are not polled.
- Expanding a previously loaded directory rereads it and its visible expanded
  descendants, retaining cached rows until completion. Reopening the workspace
  root rereads the root and visible expanded directories. This exposes folders
  created by agents or external tools while a branch was collapsed, without
  waiting for the next poll or scanning unopened branches; in-flight reads coalesce.
- The Files panel keeps a compact project-search field above the lazy tree. Typing a query runs a bounded background search over project-relative file paths and UTF-8 file contents without expanding tree nodes; `Ctrl+Shift+F` / `Cmd+Shift+F` focuses that field while the Files panel is active.
- Project search does not follow symbolic links and skips dependency/generated directories such as `.git`, `node_modules`, `target`, `dist`, `build`, `coverage`, `.next`, and `.svelte-kit`. Individual content reads are bounded to 2 MB, scanning stops after 20,000 files, and at most 500 path/content matches are returned so searching cannot turn the renderer into an unbounded filesystem walk.
- Search results show the relative path, source line/column when the hit came from file contents, and a compact line preview. Activating a content hit opens Preview at that exact source line; activating a path-only hit opens the file normally. Clearing the query returns to the existing lazy tree with its expansion/selection state intact.

## Activity Bar behavior

- The workspace rail is one vertical toolbar with a single Tab entry anchored to
  the active destination, including when the panel is collapsed. Arrow/Home/End
  navigation moves DOM focus but does not move that Tab entry; returning with Tab
  enters at the active destination rather than the last arrow-focused button.
  This is not a focus-following roving-tabindex implementation.
- The rail is a compact 40 px column with 40×40 view buttons. Density changes
  must preserve visible focus and the single-composite keyboard model.
- ArrowUp/ArrowDown and Home/End move focus without activating a destination.
- Enter/Space/click keeps the existing view-selection/collapse behavior.
- Every expanded workspace panel header includes a compact Close control. It uses
  the same collapse path as activating the already-selected Activity Bar item,
  so closing the panel preserves the current destination for the next reopen.
- The expanded workspace panel has no per-view maximum width. Pointer or keyboard
  resizing may keep widening it until the window reaches the shared minimum width
  reserved for the main conversation/workbench area.
- Focus movement does not alter indicator state or acknowledge a destination;
  acknowledgement remains tied to the view actually becoming visible.

## Implementation

- `desktop/src-tauri/src/project_browser.rs`
- `desktop/src-tauri/Cargo.toml`

- `desktop/src/App.svelte`
- `desktop/src/app/desktop-project-services.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/components/DesktopSidebar.svelte`
- `desktop/src/lib/desktop-context-target.ts`
- `desktop/src/lib/native-context-menu.ts`
- `desktop/src-tauri/src/project_directory_link.rs`
- `desktop/src/components/ProjectExplorer.svelte`
- `desktop/src/components/project-explorer-tree-controller.svelte.ts`
- `desktop/src/components/project-explorer-operations.svelte.ts`
- `desktop/src/components/project-explorer-menu-controller.svelte.ts`
- `desktop/src/lib/project-explorer-native-menu.ts`
- `desktop/src/components/project-explorer-drag-controller.svelte.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/components/workspace-sidebar-layout-controller.svelte.ts`
- `desktop/src/lib/keyboard-navigation.ts`
- `desktop/src/lib/project-tree.ts`
- `desktop/src/lib/project-git-decorations.ts`
- `desktop/src/lib/project-git-refresh.ts`
- `desktop/src/lib/project-files-refresh.ts`
- `desktop/src/lib/project-git-ignore.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/lib/project-explorer-expansion.ts`
- `desktop/src/lib/project-entry-clipboard.ts`
- `desktop/src/lib/sidebar-indicators.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/src/git_ignore.rs`

## Tests

- `desktop/src-tauri/src/project_browser.rs`: HTML eligibility and workspace validation.

- `desktop/src/lib/project-files-refresh.test.ts` covers foreground-only polling,
  focus/visibility resumption, serialized reads, failure retries and teardown during
  in-flight work. Project Explorer source tests pin the visible-directory refresh
  and mounted-component lifecycle wiring.

- `desktop/src/lib/keyboard-navigation.test.ts` covers composite and type-ahead
  navigation primitives.
- `desktop/src/lib/project-tree.test.ts` covers visible parent lookup, workspace
  root naming, nesting, empty/loading rows, and collapse without preference loss.
- `desktop/src/lib/project-explorer-expansion.test.ts` covers compact per-project
  expansion persistence, malformed state rejection, and storage bounds.
- `desktop/src/components/ProjectExplorer.test.ts` covers tree semantics and the
  keyboard external-editor route.
- `desktop/src/components/project-explorer-operations.test.ts` covers independent
  mutations during deferred deletion, ancestor/destination conflicts, partially
  copied output protection, out-of-order completion and workspace/teardown invalidation.
- `desktop/src/components/project-explorer-tree-controller.test.ts` covers deferred
  row focus after workspace replacement, teardown and changed focus intent,
  lazy reverse navigation, pending-list reuse, missing targets and newer reveals,
  descendant expansion reset on parent/root collapse, persistence and sibling preservation.
- `desktop/src/app/preview.test.ts` covers directory-link routing without Preview
  changes and stale classification cancellation.
- `desktop/src/lib/native-context-menu.test.ts` covers captured tab reveal actions.
- `desktop/src-tauri/src/project_directory_link.rs` tests directory confinement,
  file/missing-path rejection and symbolic-link rejection.
- `desktop/src/components/project-explorer-menu-controller.test.ts` covers
  measured browser-menu bounds, content growth, keyboard anchoring, stale focus
  work, observer teardown and native host routing/cancellation.
- `desktop/src/lib/project-explorer-native-menu.test.ts` covers shared command
  policy, awaited eligibility, OS coordinates, serialized registration, stale
  callbacks, error reporting and idempotent resource release.
- `desktop/src/lib/project-entry-clipboard.test.ts` covers shared references,
  format/path validation, cross-project eligibility, text replacement, failures,
  out-of-order reads and teardown. Native project-entry/copy tests cover recursive
  cross-workspace copying, preserved source contents, collision naming, exclusive
  target creation, unsafe destinations and canonical self/descendant rejection.
- Native `git_ignore` tests cover real Git eligibility, literal rules, nested
  ignore files, append preservation, tracked files/folders with unchanged index
  contents, and unsafe paths.
- `desktop/src/lib/project-git-ignore.test.ts` covers stale menu/workspace/status
  reads, teardown invalidation, stable visibility during repeated status refreshes
  and non-repository failures.
- `desktop/src/lib/project-git-decorations.test.ts` covers staged/working-tree status, conflicts, ancestor aggregation, rename/copy semantics, and clearing snapshots; `desktop/src/lib/project-git-refresh.test.ts` covers polling, request coalescing, failed reads, and in-flight teardown.
- `desktop/src/components/WorkspaceSidebar.test.ts` covers Activity Bar composite
  wiring.
- Native project-search tests cover path/content hits, case-insensitive ASCII
  matching, ignored dependency directories, and empty queries. The binary-file
  fixture is not paired with an explicit binary-skipping assertion; that coverage
  remains a gap. Project Explorer source tests pin the search command, shortcut,
  bounded result UI, and matched-line Preview navigation.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
