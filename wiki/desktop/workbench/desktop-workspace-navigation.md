---
kind: spec
status: active
---

<!-- pix:wiki-report {"version":1,"checkedAt":"2026-11-16T15:51:08.741Z","result":{"path":"wiki/desktop/workbench/desktop-workspace-navigation.md","documentHash":"3ad1995e5255cf196c07d27e0dfcad3b3fc8f3be860bbe27d8f46bab849f238d","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[{"draft":{"path":"wiki/desktop/workbench/desktop-workspace-navigation.md","quote":"See [decision 0028](../../decisions/0028-native-explorer-context-menu.md)","startLine":125,"endLine":125},"existing":{"path":"wiki/desktop/workbench/desktop-workspace-navigation.md","quote":"See [decision 0028](../../decisions/0028-scoped-file-operation-reservations.md)","startLine":282,"endLine":282},"explanation":"Внутреннее противоречие в черновике: два разных документа решений имеют один и тот же номер 0028 — один про нативное контекстное меню Explorer, другой про scoped reservations для файловых операций. Идентификатор решения должен быть уникальным; одна ссылка на decision 0028 не может одновременно указывать на два различных документа с разными предметами, поэтому по крайней мере одна из двух ссылок неверна."}],"uncertainties":[],"reviewedSources":[{"path":"wiki/usage/desktop-runtime-status.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# Desktop runtime context and model limits\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nBring the TUI's context-usage, prepared DCP context-map, and current-model quota signals into Pix Desktop without copying terminal presentation into the GUI. Desktop keeps durable DCP statistics as a separate protocol capability while rendering the live context state as dense IDE status chrome and lightweight click-open panels.\n\nDecision: [Status-bar click popups](../decisions/0048-status-bar-click-popups.md), superseding [hover details](../decisions/0037-status-bar-hover-details.md) for interaction only. Session-pane removal: [0047](../decisions/0047-remove-session-inspector.md).\n\n## Behavior\n\n- Usage remains in the left status group. The right group places Observer (shared eye-in-triangle glyph), background jobs, Plan, the session activity HUD (Steps/Subagents), then notifications; conditional controls are omitted when absent. There are no short vertical separators between groups. The status-bar top border remains; dividers inside popups and context-ring sector separators are unchanged. This replaces the historical icon, ordering and inter-group separator choices recorded in [0037](../decisions/0037-status-bar-hover-details.md).\n\n","startLine":1,"endLine":27},{"path":"wiki/desktop/integrations/desktop-git-workflows.md","quote":"- HTTP(S) transfers abort when slower than 1000 B/s for 60 s (`GIT_HTTP_LOW_SPEED_LIMIT`/`_TIME`), unless the environment or any `http.*lowSpeedLimit`/`lowSpeedTime` config sets them. If the transport configuration cannot be read, no transport setting is overridden.\n- There is no user-facing cancel for these operations yet; the deadline and transport guards bound them. The sidebar remote-update probe (`ls-remote`, 5-second deadline) shares the same supervisor.\n\n## Verification\n\nRepository-author regression coverage is in\n`desktop/src/lib/git-identity-editor.test.ts` (inherited values, errors/retry,\nread/edit races, serialized saves and disposal),\n`desktop/src/app/git-workspace.test.ts` (shared mutation lock and A → B → A\ncompletion), and `desktop/src-tauri/src/git_identity.rs` (real temporary Git\nrepositories, local-only save, included defaults, unchanged config on invalid\ninput/lock contention or staged-write failure, linked-worktree precedence,\npermissions/history preservation, and exact-root confinement). Run the native subset with\n`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_identity`.\n\nThe sparse closed-panel lane follows [sidebar indicators](../workbench/desktop-sidebar-indicators.md) and [decision 0025](../../decisions/0025-sidebar-health-polling.md).\n\n`npm --prefix desktop run check`, `npm --prefix desktop test`, and `npm --prefix desktop run build:web` cover static checking, the existing suite and production frontend compilation. Focused behavior tests are in `git-ci.test.ts`, `GitCiSection.test.ts`, `git-workspace.test.ts`, `git-assist-workflow.test.ts`, `git-assist.test.ts`, `desktop-workbench-prop-builders.test.ts`, `git-workflow.test.ts` and `DesktopEditorSurfaces.test.ts`; CI-repair tests cover default/configured model selection, prompt policy and stale failed-HEAD cleanup, while the CI store tests cover stale workspace/HEAD completion, refresh coalescing, teardown cancellation and serialized job loading. Rust tests cover provider URL/status normalization in addition to exact-root Git initialization and nested-repository refusal. ACP request parsing and standalone dispatch are covered by `acp/test/desktop-commands.test.ts` and `acp/test/agent.test.ts`.\n\n`npm --prefix desktop run test:git-workflow` mounts the real Svelte components with deterministic fake Git/ACP callbacks in Chromium. It exercises all three flows, partial/explicit staging, draft races, push partial success, no-session/no-remote/conflict states, keyboard controls, stable review/diff selection, full-height review and 360px light/dark Source Control geometry/semantic colors. Screenshots are written to ignored `desktop/.artifacts/git-workflow/`.\n\n`cargo test --manifest-path desktop/src-tauri/Cargo.toml git_secondary` exercises real local Git in temporary repositories: bounded/unborn history, stash/index/untracked preservation, safe discard, fetch/pull and divergence refusal. Browser callbacks do not contact a remote or paid model, and these tests do not alter the user's repository index, commits, remotes or stashes. Live provider/native-webview end-to-end behavior is a separate integration check, not asserted by the browser fixture.\n","startLine":196,"endLine":217},{"path":"wiki/development/release/release-distribution.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# GitHub Release distribution\n\n## Scope and version\n\nPix ships standalone Node runtime payloads in portable TUI archives and Tauri\nDesktop installers. The two variants share preparation code, not an identical\nfile inventory: only Desktop includes ACP. GitHub Releases are the only supported\ndistribution channel; the root package is private and must not be published to npm.\nDesktop product support is currently macOS only. Windows/Linux Desktop packaging\npaths and historical measurements below do not make those supported products;\ntheir validation is not a current Desktop delivery gate. TUI target support is unchanged.\nRoot `package.json` is the authoritative application version. ACP, Desktop,\nTauri, the Pix Cargo package, and the three npm lockfile root records share it.\n`npm version` runs `scripts/release/sync-version.mjs --stage` before creating its\ncommit/tag; `release:version:check` rejects drift. Releases use stable `vX.Y.Z`\ntags. The external tools\nsuite is not independently version-bumped.\n\n## Payload invariants\n\n- Targets are `linux-x64`, `macos-arm64`, and `windows-x64`. Packaging\n  runs natively on each target. Unsupported/cross-host targets fail before output\n  cleanup or dependency installation.\n- Node is downloaded from the official HTTPS distribution for the exact stable\n  version currently selected by the release builder's PATH. The repository does\n  not pin that version. The exact filename must appear once in `SHASUMS256.txt`;\n  its SHA-256 is verified before extraction. `release.json` records the source\n","startLine":1,"endLine":32},{"path":"wiki/decisions/0058-reverse-file-navigation.md","quote":"# 0058 — Reverse navigation into Files\n\n- Status: accepted\n- Recorded: 2026-10-05\n- Decided: 2026-10-05\n- Owner / approval evidence: user confirmed IDE-style reverse navigation in this\n  task's conversation; no separate durable approval artifact.\n- Governing spec: [Workspace navigation](../desktop/workbench/desktop-workspace-navigation.md),\n  [context menus](../desktop/workbench/desktop-context-menus.md),\n  [Markdown rendering](../desktop/rendering/desktop-markdown-rendering.md)\n- Replaces / replaced by: none\n\n## Context\n\nRelative folder links and Preview/editor tabs need a route back to their entries\nin the project tree, like an IDE.\n\n## Observations and sources\n\nThe existing Explorer owns lazy directory loading, selection and focus/scroll.\nPreview tab metadata supplies trusted file paths to the generic native menu.\nThese are code observations, not claims of native UI acceptance.\n\n## Decision\n\nUse one Explorer reveal operation for both actions. Keep the project root,\nclear Files search, expand parents, select and scroll/focus the target. Expand\ndirectory targets too. Do not reopen the editor or modify its draft. Resolve\nrelative links from the workspace first, preserving Markdown's existing fallback.\nOmit tab reveal for paths outside the workspace; retain existing Finder actions.\n\n## Alternatives\n\nChanging the Explorer root to the selected folder was explicitly excluded in\nthe user-confirmed interpretation. Reopening the file would unnecessarily touch\nPreview navigation instead of providing reverse navigation.\n\n## Consequences\n\nNavigation preserves workspace context and editor drafts. Only the needed lazy\nbranch is loaded; asynchronous work requires replacement/workspace/teardown\nguards. Outside-project files remain reachable through OS actions, not this tree.\n\n## Revisit when\n\nExplorer supports multiple roots, external files, or separate editor tabs.\n\n\n","startLine":1,"endLine":48},{"path":"wiki/desktop/rendering/desktop-markdown-rendering.md","quote":"- Rendering raw HTML.\n- Executing raw HTML inside the Markdown renderer. Explicit assistant-only\n  `pix-html` fences use a separate opt-in iframe sandbox instead; see\n  [interactive HTML sandbox](desktop-html-sandbox.md).\n- Treating arbitrary tool output as Markdown; only Markdown `read` results use the\n  Markdown renderer.\n- Fetching remote images in regular transcript Markdown.\n\n## Behavior\n\n- User, assistant, thought, and system text use the same Markdown renderer.\n- Complete DCP message-id control blocks are removed from rendered transcript\n  Markdown. Incomplete control markup remains visible while streaming so the\n  renderer fails open instead of hiding ordinary partial text.\n- Markdown `read` tool results use the same renderer in a dense tool-result\n  presentation; other tool results keep their dedicated plain/code/diff views.\n- Raw HTML is always escaped; Markdown never injects executable markup.\n- Underscores inside words, identifiers and filenames remain literal, including\n  Markdown link labels and media captions (`01_M_Supertonic_M1.mp3`). Standalone\n  `_emphasis_`, `__strong__` and `___both___` use whitespace/punctuation-aware\n  opening and closing boundaries; escaped or unclosed underscores stay readable.\n- Markdown headings use the semantic warning accent mixed with the foreground so\n  their hierarchy stays prominent with a restrained warm tone in both themes.\n- Ordered lists retain native numbering; their marker gutter is sized in `ch`\n  from the final native number (`start + item count - 1`), with tabular numeric\n  outside markers and logical padding so multi-digit markers fit within paint\n  containment while wrapped item text remains hanging-aligned. Bullet lists use\n  a logical `1.35em` gutter.\n- Inline code uses the Desktop semantic accent rather than ordinary prose color.\n- Fenced `mermaid` blocks render as diagrams using Mermaid strict security and\n  HTML labels disabled. While rendering is pending, or if parsing/rendering\n  fails, the escaped source remains readable.\n- Recognized LaTeX math delimiters use KaTeX with bundled fonts; code spans and\n  fences remain literal, and malformed/streaming formulas retain escaped source.\n- Explicit Markdown links and bare URLs with `http`, `https`, or `mailto` schemes become links.\n- A standalone `http://`, `https://`, or `mailto:` URL inside inline code also\n  becomes an external link, preserving its code styling and full destination\n  (including localhost ports, queries, and fragments). Inline code containing\n  commands or whitespace, fenced code, and unsupported schemes remain literal;\n  code labels inside explicit Markdown links do not gain nested links.\n- Relative project links may also name existing directories. Activation uses\n  Files reverse navigation instead of Preview or the OS opener: open the panel,\n  clear search, expand ancestors and the folder, select and scroll to it while\n  retaining the project tree root. Directory validation stays workspace-confined\n  and rejects symlinks. The same workspace-root-first resolution applies inside\n  Markdown Preview. See [workspace navigation](../workbench/desktop-workspace-navigation.md)\n  and [decision 0058](../../decisions/0058-reverse-file-navigation.md).\n- Inline-code relative paths ending in `/` (or `\\`) are directory-link\n  candidates even without a file extension or `./` prefix, including hidden\n  paths such as `.pi/artifacts/usage-popup-mockups/`. Preserve the displayed\n  code text, normalize the target, and make it clickable only after the existing\n  workspace-confined existence validation succeeds. Missing or rejected targets\n  remain ordinary inline code.\n- External Markdown links are marked with an external-link icon in both transcripts and the Preview editor.\n- Successfully validated project and home/local file links prepend a decorative,\n  aria-hidden Lucide icon classified by destination extension (HTML `.html` and\n  `.htm` files, case-insensitively, use Globe; code/config,\n  text/Markdown, image, audio, video, archive, PDF, or generic file). Validated\n  project and absolute local directories use the Folder icon based on validation\n  metadata, including directories whose names contain dots. Missing or otherwise\n  unvalidated candidates remain plain labels without a file icon. External links\n  retain their existing trailing external-link icon. Icons do not replace link\n  labels or navigation/line-range metadata; shared `MarkdownText` applies this in\n  transcripts and Preview. Lazy validation preserves the file/directory kind;\n  Preview resolves project targets workspace-root-first, then document-relative.\n  Home-directory links retain their existing behavior; home directories are not\n  supported as directory links.\n- Explicit Markdown links with relative destinations and inline-code values that look like relative file paths become project-file links. Explicit links preserve GitHub-style `#Lline` and `#Lstart-Lend` fragments as source line ranges; other fragments remain ordinary fragment-free project links. Inline-code references may carry `:line`, `:start-end`, or `:line:column` suffixes; the column is ignored and the line/range is preserved for preview navigation. Activating a project link reads the target only when its canonical path remains inside the active workspace, then activates the Preview editor with syntax highlighting and line numbers. A preserved line range opens the source view (including for Markdown files), highlights the requested lines, and reveals the first requested line on an otherwise fresh preview entry.\n","startLine":39,"endLine":106},{"path":"wiki/work-management/registry/desktop-registry-plans.md","quote":"  `failed` (prompt error or non-`end_turn`/`cancelled` stop reason) → **Failed**,\n  `cancelled` → **Interrupted**, `completed` → **Done** unless the saved\n  checklist still has open items (**Interrupted**). Without an outcome (app quit\n  mid-run, legacy record) the saved checklist alone decides. Outcomes persist as\n  optional `outcome`/`settledAt` in the launch record; malformed values drop only\n  the status. A recorded launch whose prompt never starts settles as\n  `cancelled` (navigated away) or `failed` (runtime not ready, plan removed,\n  error).\n- **Resume** appears in the menu only when the newest run is Failed or\n  Interrupted and no run of the plan is Running; it shares Run's disabled state.\n  It opens a new session with a continuation prompt (inspect partial changes,\n  re-verify `[x]` items, continue from the first unchecked item) followed by the\n  standard Run prompt, and records a new launch.\n- The status-bar plan chip shows the run status and, for the newest resumable\n  run of the plan, a **Resume in new session** button with the same readiness\n  guard.\n- Checklist progress comes from the native `list_project_documents` snapshot's\n  `planProgress` map, keyed by plan path and containing `{ completed, total }`\n  or `null`. The native parser counts Markdown task markers, including nested,\n  ordered and quoted lists, while excluding fenced/indented code, HTML comments\n  and metadata. Counts reflect saved files. Unreadable, invalid-UTF-8 or\n  oversized files are unavailable. The count snapshot refuses/skips paths that\n  are not canonical project paths, including symlink/escaping paths; existing\n  plan enumeration may still report a list error for symlinks.\n- Progress is refreshed through the existing project-files refresh while the\n  Work Plans panel is mounted in the foreground (3-second interval). It\n  stops while hidden/unfocused or unmounted; calls do not overlap and owned\n  listeners/timers are disposed. There is no new filesystem watcher or runtime\n  network dependency. Native counting runs off the UI thread, caches only\n  counts/fingerprints by full canonical path, and bounds cache/read work; files\n  deferred by a snapshot read budget are retried on the next poll. Unchanged\n  versions do not repeat diagnostic failures. Existing document-load generation\n  guards prevent stale workspace/reset responses from applying.\n\n## Desktop agent guidance\n\n","startLine":99,"endLine":134},{"path":"wiki/desktop/rendering/desktop-activity-row-timing.md","quote":"\nActive implemented contract.\n\n## Goal\n\nMake collapsed Desktop activity rows compactly show the full thinking/tool flow and elapsed time both while activity is live and after it completes. Live \"what is active now\" status is delegated to a separate pinned status above the composer, outside the chat transcript.\n\n## Behavior\n\n- Consecutive thinking blocks and tool calls form one collapsible activity group. A visible user, assistant, or system message ends the group.\n- The shared activity icon mapping uses Logs for `shell_output`/`BashOutput`, ListTree for `shell_jobs`, OctagonX for `shell_kill`/`KillShell`, and ScanEye for `lookup`. These identities appear in both the collapsed trail and expanded child rows; expanded icon color continues to communicate lifecycle status.\n- A collapsed activity group header is a single-line native disclosure summary with exactly one disclosure chevron, one muted Lucide icon per thinking/tool entry in transcript order (including repeats), and the elapsed duration. SKILL.md reads use the GraduationCap icon and the `skill \u003cname\u003e` label. Image reads use the Lucide Image icon while retaining the `read` tooltip and accessible label. Image-read classification is cached at transcript ingestion from read path/file_path/filePath, ACP location or Read title image extension, or an image output attachment; collapsed rendering does not parse payloads. Each icon has a native-title tooltip and screen-reader-only label; unknown tools use Wrench. The icon trail scrolls horizontally with its scrollbar hidden rather than deduplicating or truncating. The expanded header does not mount the icon trail; it has a screen-reader-only “Tool activity” label while retaining the disclosure chevron and duration. The header adds no aggregate status icon, no action or status text (`+N more`, `Completed`, `Failed`), no second row, and no failure inheritance — per-tool status and failure icons stay on the child rows inside the expanded group. Live-only activity status belongs to the pinned composer status above the input, not the chat header.\n- For groups of up to 128 entries, all trail icons mount. Larger groups mount only icons in the horizontal viewport plus four entries of overscan on each side; a full-width spacer preserves scrolling across the complete logical trail. All entries remain in order and in the screen-reader label. Viewport sizing is observed with a `ResizeObserver` that is disconnected on teardown; icon virtualization does not mount tool/thinking bodies.\n- The pinned composer status shows no spinner; a narrow highlight sweeps across the action text at a constant pixel speed regardless of the visible label width, while the text stays in place. With reduced motion, it renders as static muted text.\n- Its row places run controls at the right edge outside the status live region, with truncating activity text on the left. Pause/Stop and resumable Continue belong here rather than inside the message input; see [Desktop agent pause and continuation](../conversations/desktop-agent-pause.md). The row remains visible for resumable control states even without live activity metadata, using static status text rather than a live sweep.\n- Historical/replayed thinking without enough timing metadata is not synthesized as active.\n- The deterministic live-action derivation uses a fixed label set from normalized tool metadata. The reducer caches an optional action at tool ingestion/update: exact `subagents` actions distinguish starting, waiting, checking and stopping agents; conservative executable/script recognition distinguishes running tests, building and checking a project. These are intent labels, not success claims. Render-time derivation never parses raw arguments or outputs. See [Conservative composer action inference](../../decisions/0013-composer-action-inference.md).\n- Named repository tools distinguish context gathering, project inspection (`repo_inspect`: `Inspecting project`), and knowledge audits. Legacy architecture, structure, implementation and dependency tool names retain their labels for existing sessions. Session-history tools, context compaction, model council, and parallel-tool coordination also have specific labels; unknown tools retain their kind-based or generic fallback.\n- An active `codemode` call shows `Running code` in the pinned composer status, without displaying its JavaScript payload.\n- The pinned status lists every active entry in call order on one line, separated by ` • `, without deduplication or a `+N more` hint. Each file read/mutation may append its normalized skill name or file basename. Directory prefixes, URLs, query/fragment strings, control characters and bidi controls are not displayed. Context is bounded to 64 characters; the whole single-line label truncates with ellipsis and its full safe label is available on hover. Settled entries disappear; entries before the current user-turn boundary are excluded. Missing live evidence still shows `Working`; it does not invent a model-response phase.\n- Command inference accepts only bounded simple commands with recognized executable/script prefixes (test/build/check/typecheck/lint and colon suffixes for package scripts). Unknown leading prefixes/options, environment wrappers, shell composition/redirection/substitution, quotes, control/bidi characters and help/version/dry-run/list flags retain the generic command label. Command text and subagent task payloads never appear in the label. Argument/name changes refresh or clear the cache; status-only updates retain it. A running shell with no recognized simple intent remains `Running command`.\n- The collapsed icon trail remains muted and unchanged. Expanded child rows use the same tool-identity icons as the trail (including image reads and the unknown-tool fallback); icon color, rather than glyph, conveys pending, in-progress, completed, failed, and completed-attention status, with status retained in the tooltip and accessible label. Thinking uses the brain icon, primary while started without an end and success when completed, including historical untimed thoughts. A failed child tool call does not change the header; its failed color stays on its own child row. Expanded tool names keep their native operation colors.\n- An activity group with a recorded start shows a muted elapsed duration on the header's single line, including while any entry is live. The live value advances from the earliest recorded start to the current pane clock; it freezes to the persisted final duration as soon as activity settles.\n- Activity-group duration is the wall-clock span from the earliest recorded thinking/tool start to the latest recorded thinking/tool completion. Parallel calls therefore do not double-count elapsed time.\n- Thinking starts at the first live thought chunk and ends at the next visible assistant/tool/user activity boundary. If a prompt settles without another visible update, prompt settlement closes the trailing thinking interval.\n- Duration capture piggybacks on existing Desktop session updates. A single pane-level interval samples elapsed time only while that pane has at least one active activity group with a recorded start. Its cadence follows the displayed precision of the newest live group: 100 ms while that group is under 10 s (tenths are shown), then 1 s (whole seconds or coarser); a newly started group switches it back to 100 ms. It is cleared when no activity remains active and on pane teardown; rows never own timers and inactive rows do not receive clock updates.\n- Persisted history reuses timestamps already present in Pi JSONL instead of inventing a timer. The assistant message timestamp plus its enclosing session-entry timestamp reconstruct the persisted model-response span; the enclosing assistant entry marks the start of following tool execution, and each tool-result entry marks that tool's completion.\n- A replayed assistant response with exactly one thinking block may show that persisted response span on the thinking row. When one assistant response contains multiple thinking blocks, replay omits per-thinking duration because the session format has no per-block timestamps and assigning the same duration to each block would be misleading.\n- History without the required persisted timestamps still omits duration.\n","startLine":10,"endLine":38},{"path":"wiki/desktop/workbench/desktop-context-menus.md","quote":"  message. Existing user-message Copy/Fork/Fork in new tab/Undo remains available\n  through right-click without a text/link context and through the ellipsis even\n  when text is selected.\n- External links offer Open Link and Copy Link Address. Links use the existing\n  `normalizeExternalHref` protocol policy, so internal anchors, local files,\n  javascript and other unsupported destinations are not passed to the URL opener.\n  A selected link also offers selection Copy.\n- Right-clicking a source line or its line-number gutter in the built-in Preview\n  offers **Copy Relative Path with Line Number**, copying plain `path:line` text\n  relative to the project root (for example `src/main.ts:42`). The clicked logical\n  source line determines the one-based number, regardless of wrapping, scrolling,\n  or a highlighted navigation range. Selection Copy remains available alongside\n  this action. Rendered Markdown, the edit textarea, and blank Preview space do\n  not infer a source line. Absolute local-file previews use a workspace-relative\n  path, including `../` outside the project; without a workspace they omit the action.\n- Images in Markdown and the Preview tab offer Open Image in External App and\n  Copy Image, taking precedence over a surrounding link. Local images use the\n  backend-approved attachment path and the OS default application, not the text\n  editor. Data images are cached as PNG before opening; remote images open their\n  HTTP(S) URL. Copy Image writes PNG pixels, not a path or link. Conversion is\n  bounded to 16 megapixels. Asset-backed local images are read through the backend's approved\n  attachment reader (25 MB limit) and decoded as data images before PNG conversion,\n  avoiding WebKit's asset-URL canvas security error without weakening CORS.\n  Already embedded data images retain their pixels without re-reading the original file.\n  Errors (including unloaded or unsupported cross-origin remote images)\n  use the application error reporter. Stale conversion/cache completions cannot\n  write the clipboard or open an app after replacement/disposal. Image copy also\n  rejects stale completions when the same element's source or local path changes;\n  temporary decode images are released on success, failure, and cancellation.\n- Image menus also offer Copy Absolute Path and Copy Relative Path (relative to\n  the active project root, with `../` for files outside it). These copy captured\n  plain filesystem paths without URI escaping. Images without a local file path\n  disable both commands; without an active project, relative-path copy is disabled.\n- Local images additionally offer **Reveal in Finder**; remote/data-only images\n  disable it. Attachment thumbnails expose their approved local path just like\n  images inside Preview.\n- The Preview tab header, its read-only content/blank space, and file/video\n  attachments offer **Copy File**, **Open in External App**, and **Reveal in\n  Finder**. These use the captured local file, not the tab's display title or an\n  asset URL. Relative project paths resolve against the current workspace;\n  missing local paths disable all three actions. Input/editing menus retain\n  precedence; selected text and source-line copy remain available alongside file\n  commands. Clicking an image still copies PNG pixels through **Copy Image**;\n  clicking the tab header copies the underlying file.\n- Embedded Markdown media uses its resolved attachment path, not the surrounding\n  document's path. Pending/unavailable media blocks that enclosing-file fallback\n  and disables local file actions until resolution succeeds.\n- Preview/editor tab headers additionally offer **Show in Files** for targets\n  inside the active workspace (including absolute local paths within it). The\n  command opens Files, clears its search, expands parents, selects and scrolls\n  to the file without reopening it or touching unsaved content. Outside-project\n  tabs omit it. The captured path and workspace are guarded against stale menu\n  callbacks. See [workspace navigation](desktop-workspace-navigation.md) and\n  [decision 0058](../../decisions/0058-reverse-file-navigation.md).\n- Markdown links to local project files offer **Open in Browser** for `.html` and\n  `.htm` targets, before **Show in Files** / **Reveal in Finder**. The native\n  file-action command revalidates that the resolved target is HTML and opens it\n  using the default HTTPS browser rather than the `.html` file association.\n- On macOS, Copy File places a native file URL on the pasteboard for Finder and\n  other applications, not plain path text or Project Explorer's private\n  cross-instance clipboard payload. Open uses the OS default application, not\n  the configured text editor. No implicit save/export of an unsaved draft occurs.\n  See [decision 0042](../../decisions/0042-preview-file-context-actions.md).\n- xterm keeps its native clipboard event path; terminal menus offer Copy and,\n  while the terminal accepts input, Paste. They do not offer document Select All\n  or text-editor Undo. `TerminalView` exposes its read-only state explicitly.\n\n## Native integration\n\n","startLine":63,"endLine":131},{"path":"wiki/work-management/registry/resource-registry-project-state.md","quote":"  fallback during ordinary Registry operations. Such files and local migration\n  backups are ignored for dirty detection and not published; users retain\n  control of their original files.\n- SQLite schema v1 and canonical task attachments are the only supported\n  Registry task representation. Task descriptions remain plain text; no legacy\n  `file://` marker resolution or rebasing occurs.\n\n## Invariants\n\n- Registry attachment names cannot escape the task-attachment directory.\n- Registry task attachments must be immutable SHA-256-named regular files;\n  symbolic links, hard links and mismatched hashes are rejected.\n- Task attachment references exist only in SQLite relations, not in text markers.\n- Referenced attachment content participates in provenance hashing. A task push\n  removes no-longer-referenced blobs from the remote Git artifact.\n- Every successful Desktop task mutation reaches the background sync coordinator\n  through the SQLite task save path; failed local persistence never\n  schedules a remote push.\n- Background project sync is coalesced to one in-flight Registry action. It does\n  not force-push through provenance conflicts.\n- The sidebar's cheap Registry task check hashes the same normalized task bundle\n  as Registry provenance, including referenced attachment bytes, so a completed\n  background push can converge back to a clean local indicator. Each poll first\n  compares a metadata-only stamp (`tasks.sqlite`, its WAL, and the size/mtime of\n  every `.pi/task-attachments/` blob) and rehashes the bundle only when that\n  stamp changes; a WAL checkpoint may cause one extra rehash, never a missed edit.\n- Desktop full project-state scaffold initialization is optional and idempotent;\n  ordinary Desktop writes lazily create only the storage they require. The\n  initialized marker always requires the complete scaffold: a regular\n  `.pi/tasks.sqlite` plus project-owned regular `.pi/plans/` and\n  `.pi/task-attachments/` directories. A bare `.pi` directory or unrelated\n  `.pi/pix.jsonc` is not initialized state. Existing task content is never\n  overwritten, and `.pi` plus scaffold subdirectories must be regular\n  project-owned directories rather than symbolic links escaping the workspace.\n- Initialization inspects an already-existing `tasks.sqlite` before accepting a\n  concurrent publication race: it must be a regular file canonically inside `.pi`,\n  and its schema version must be compatible.\n  An existing symbolic link, directory, or escaping target is an error, never\n  an idempotent-success result.\n- The Registry panel reports the logical byte size of the current project-owned\n  `.pi` tree plus the currently reclaimable generated-junk byte count. Size\n  traversal never follows symbolic-link targets; a missing `.pi` is represented\n  as absent rather than as an alternate storage layout.\n- Total and reclaimable bytes are returned by one native storage inspection so\n  the panel does not duplicate full-tree traversal. Desktop bounds local project\n  inspection waits to five seconds; a stalled or failed storage inspection ends\n  the loading state with a local unavailable/timeout status, and a later Refresh\n  starts a new inspection instead of leaving `Checking…` indefinitely. A storage\n  inspection timeout or failure does not disable `Clean .pi`: confirmation states\n  that the size is unavailable rather than showing a stale reclaimable estimate.\n  Cleanup still shares the action/storage mutex and revalidates the current\n  snapshot, size result and error state after confirmation; known-empty storage\n  and an inspection still loading remain disabled. Inspection failures emit the\n  existing diagnostic warning once per failure streak; recovery or workspace\n  reset allows a later streak to warn again.\n- Registry cleanup is allowlist-based and never resets project state. The\n  canonical top-level project directories are `agents/`, `artifacts/`,\n  `plans/`, `search/`, `skills/`, `subagents/`, and `task-attachments/`.\n  Unsupported legacy `tasks.d/` is not canonical and is reclaimable.\n- Cleanup preserves the canonical `agents/`, `plans/`, `search/`, `skills/`, and\n  `task-attachments/` trees, but removes every entry recursively inside\n  `.pi/artifacts/` and `.pi/subagents/` while leaving those two container\n  directories in place. Subagent cleanup preserves any scope containing\n  owned-launch records; Manual Clean removes its other contents but retains\n  `owned/` (unknown ownership fails closed) until async-subagent cleanup proves\n  those launches drained and retired.\n- `.pi/search/index.sqlite` is durable universal-search state, not disposable\n","startLine":269,"endLine":335},{"path":"wiki/desktop/integrations/desktop-package-scripts.md","quote":"- Closing a terminal stops it when necessary, forgets its backend record, removes its decoder/state, and selects a neighboring terminal when the closed tab was active.\n- Starting/restarting/closing actions are serialized by panel action state so conflicting terminal mutations are not issued concurrently.\n\n## Verification\n\n- Compact name-only package-script filtering, terminal snapshot decoding, bounded output, and status helpers.\n- Checks the narrowly scoped style-only Tauri CSP exemption, declared inline style policy, lack of inline script allowance, and release override inheritance.\n- Desktop visual/source regressions cover the shared full xterm surface, native block/outline cursor behavior, Geist Mono 10 px terminal font and bundled Nerd fallback, standard ANSI palette retention, color-capable PTY environment, explicit 5,000-line xterm scrollback, visible scrollbar styling, and name-only script rows. The font tests check actual bundled cmap coverage for representative BMP and supplementary Nerd glyphs, the full license in the public assets copied into the Desktop frontend, and guarded DOM width-cache invalidation/repaint on late font loads.\n- Terminal lifetime tests use controlled animation frames and link promises to check unmount cancellation, late success/failure suppression, and normal initial/resize/link behavior.\n- Input tests use controlled acknowledgements to check ordering, independent terminals, Unicode boundaries, and recovery after failed writes. Controller tests cover workspace changes during launch/restart, initial shell-command ownership, launch reservation, and teardown.\n- Client-runes reactivity tests replace spread sidebar props at an unchanged workspace during a launch and initial load; they check that unrelated updates do not reload/cancel work, while real workspace changes still load and reject stale completions.\n- Launch-command tests cover JSONC round-tripping alongside other project settings, create/update/delete conflict handling, stale workspace completion, and the UI lifecycle for edit/delete/launch.\n- `npm --prefix desktop run check`\n- `npm --prefix desktop test`\n- `npm --prefix desktop run build:web`\n\n## Evidence\n\n- Confirmed by code: `PackageScriptsPanel.svelte` and `WorkbenchTerminalPane.svelte` both mount the same `TerminalSessionsPane.svelte` + `TerminalView.svelte` terminal surface, while `package-scripts-controller.svelte.ts` owns workspace loading, terminal events, streaming decoders, process mutations, active-terminal selection, and focus handoff.\n","startLine":46,"endLine":64},{"path":"wiki/context/dcp.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# dcp: dynamic context pruning (as-is spec)\n\n\u003e Risk classes: **data / cross-cutting / provider-context mutation**. DCP is\n\u003e headless. Raw Pi session messages remain the recovery source; DCP changes only\n\u003e the projected provider context and persists durable projection decisions as\n\u003e structured `dcp-journal` custom entries in the same session JSONL.\n\n## Type\n\nAs-is\n\n## Lifecycle\n\nActive implemented contract.\n\n## Purpose\n\nDCP keeps a long-running agent inside its context budget without rewriting the\nraw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`\ntool, can apply exact continuation summaries, and has a bounded emergency path.\nHistorical details are recovered through `session` history actions, not by expanding a\ncompressed block back into the provider prefix.\n\nOnly sessions created by the journal implementation are supported. There is no\nsidecar importer, legacy state reader, dual-write mode, `decompress`, or\n`recompress` compatibility path.\n\n## Lifecycle and persistence\n\n1. A confirmed new persistent session receives one `dcp-journal` `init` custom\n   entry before DCP publishes provider-visible addressing/rewrite decisions.\n   Ephemeral sessions use the same contract in memory for their lifetime.\n2. `session_start` resets transient runtime state and replays the complete\n   journal on the active branch. A non-empty persisted session without a valid\n   journal is deliberately unsupported rather than adopted as a new DCP\n   session. Unknown versions, broken predecessor chains, or conflicting\n   operation IDs fail closed.\n","startLine":1,"endLine":42},{"path":"wiki/rendering/file-link-opening.md","quote":"---\nkind: spec\nstatus: active\n---\n\n# File link opening\n\n\u003c!-- markdownlint-disable MD013 --\u003e\n\n## Type\n\nChange\n\n## Lifecycle\n\nActive implemented contract.\n\n## Goal\n\nOpen local links in the application appropriate to the current environment without sending media files to Zed.\n\n## Behavior\n\n- This screen-level opener contract applies to Pix terminal/TUI file opening.\n  Pix Desktop intercepts validated bounded UTF-8 local text targets into its\n  read-only Preview first; only targets that cannot be text-previewed fall back\n  to the system opener, which may itself be configured to Zed.\n- HTTP(S) links use the current OS system opener.\n- When pix runs inside Zed, non-media local files open through the Zed CLI and preserve an available line and column.\n- File references with a line range are opened at the range's first line because the Zed CLI target format does not preserve an end line.\n- Image, video, and audio files always use the current OS system opener, including when pix runs inside Zed.\n- Outside Zed, all local files use the current OS system opener.\n- If the Zed CLI is unavailable, opening falls back to the current OS system opener.\n\n## Non-goals\n\n- Detecting or launching other code editors.\n- Content-based MIME detection.\n- Changing link detection or mouse hit-testing.\n\n## Verification\n\n- Unit tests cover Zed text links, range-to-first-line fallback, Zed media links, non-Zed links, and platform fallbacks.\n- `npm run check`\n\n## Evidence\n\n- Confirmed by code: HTTP(S) links use the OS opener; inside Zed, non-media\n  local files use the Zed CLI with line/column when available; media uses the OS\n  opener; missing Zed CLI falls back to the OS opener.\n","startLine":1,"endLine":50}],"notices":[],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":66,"excerptedSources":11,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"conflicts"}} -->

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
  reveal action. See [decision 0058](../../decisions/0058-reverse-file-navigation.md).
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
  and Copy Project Name / Copy Absolute Path, without requiring empty space below
  the file list. Copy Project Name copies the root entry's name; Copy Absolute
  Path copies the active workspace path verbatim. The root cannot be renamed,
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
  Duplicate, Rename, Copy Relative Path, Copy Project Name for the root,
  Copy Absolute Path, and Delete where applicable. Relative-path copying applies
  to files and folders below the workspace root and copies
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
  See [decision 0028](../../decisions/0028-native-explorer-context-menu.md).
- The standalone browser preview retains the DOM menu, bounded inside its
  viewport with an 8 px inset using rendered dimensions. It repositions on
  content changes, scrolls internally if needed and dismisses on window resize.
- The same context menu reveals the targeted file or folder in the OS file manager,
  or opens the project folder for the root context menu. On supported macOS
  Desktop the label is **Reveal in Finder**, and Finder selects the targeted
  entry. The native command validates the target
  against the workspace and rejects symlink targets or escaped paths.
- In the Tauri Desktop chat context menu, a Markdown project-file link also offers
  **Open on GitHub** or **Open on GitLab** between **Show in Files** and
  **Reveal in Finder** when its workspace-relative target resolves to a supported
  Git remote link. Links outside the current project do not offer this action.
  Remote lookup is ordered with native menu registration; lookup failures silently
  hide the item. Activating it opens the resolved URL in the external browser.
- When Git is available and the repository's selected remote is hosted on
  GitHub or GitLab (including self-hosted instances), the context menu offers
  **Open on GitHub** or **Open on GitLab** for files, folders and the project
  root. Remote selection matches Git CI: branch upstream remote, otherwise
  `origin`, otherwise the sole configured remote. The link targets the current
  branch, or the detached HEAD commit, and uses a file or tree URL with
  percent-encoded path segments. SSH remotes open over HTTPS without the SSH
  port; HTTP(S) remotes retain their scheme and port. Unsupported/missing
  remotes, unavailable Git or failed lookups hide the item. Lookup results are
  generation-guarded so stale results cannot populate a newer menu; failures
  opening the link are logged as `project-explorer:open-remote-failed` and
  shown through the explorer operation error surface.
- `F2` renames the focused entry, `Delete` requests deletion, and the platform
  primary Copy/Paste shortcuts operate on the Project Explorer entry clipboard
  while tree focus is active. These shortcuts do not replace normal text-editing
  shortcuts outside the tree.
- Tree selection supports Cmd/Ctrl-click toggling, Shift-click and Shift+Arrow
  visible-range extension, and Cmd/Ctrl+A for all visible entries. The workspace
  root is excluded; selected descendants of selected directories are deduplicated
  before group operations. Dragging selected entries onto a folder or root moves
  them together; Escape cancels the drag. On macOS, the existing Files tree uses
  an AppKit file-URL drag source, not a replacement native/Finder tree. Dragging
  Files into Finder copies by default and requests Move with Cmd; Finder owns
  the transfer, and Pix never deletes originals in the source-ended callback.
  Outbound Finder transfers are outside Pix Undo/Redo; the source tree refreshes
  after the native session ends.
- Finder file/folder drops onto a Files folder or tree background copy by
  default; Cmd requests a move. File rows and non-tree controls reject drops
  rather than falling back to the project root or composer. Accepted imports
  use the existing scoped operation/history owner, with Undo/Redo, no overwrite,
  descendant deduplication and protected-path/symlink guards. Inbound moves use
  exclusive rename; cross-volume moves fail without copy-and-delete fallback.
  Copy keeps the existing collision-free naming policy. Native incoming data is
  captured from the actual `NSDraggingInfo.draggingPasteboard`, not the general
  clipboard or a globally named drag board; ordinary text paths are not files.
  Main-thread capture consumes a label-scoped, expiring one-shot snapshot with
  bounded URL data. A new native drag clears an unconsumed snapshot; unsupported
  file promises cannot reuse an older file drop. Capture reads the registered
  context directly without asynchronously dispatching another webview callback;
  URL resolution and filesystem validation run off the UI thread. Source
  cancellation, document reload, window/panel teardown and workspace replacement
  invalidate pending preparation or stale completions. A bounded watchdog
  acknowledges an unstarted native source without prematurely releasing it.
  Quarantined sources reject transfers and block a second session on that view;
  ownership is released only by the matching ended callback, or after button-up
  if the source never began. Active AppKit sessions retain ownership until their
  ended callback. The pinned Wry class's
  drag callback ABI is checked before bridging WebKit's DOM negotiation; an
  incompatible bridge fails closed instead of importing unrelated clipboard data.
- Finder-to-composer and Files-to-composer drops insert path references only,
  even with Cmd, and never copy/move/delete originals. Same-workspace Files
  references remain relative using immutable native source metadata; external
  paths remain absolute. Existing question attachment routing is retained.
- New File/New Folder and Rename edit the name inline in the tree, without a
  dialog. Creation expands the destination (including the workspace root) and
  inserts a temporary input as its first child; rename replaces the targeted
  row. The input takes focus and is the tree's only Tab stop while editing.
  Rename selects a file's basename without its final extension, or the full
  name for folders, extensionless files and dotfiles without a later dot.
  `Enter` submits, `Escape` cancels and restores row focus; leaving the input
  cancels without moving focus back. IME composition does not submit or cancel.
  Clipboard and arrow keys retain native text-input behavior. Empty names,
  `.`/`..` and path separators show inline validation without filesystem I/O;
  unchanged rename cancels without a mutation. Workspace replacement and panel
  teardown discard the input and invalidate stale callbacks/completions.
- Copy writes a versioned Pix file/folder reference (source workspace, relative
  path and kind) to the system clipboard. In native macOS Desktop, Copy writes
  Finder-readable file URLs together with the Pix version-2 reference in one
  pasteboard transaction; Paste prioritizes that Pix reference when both are
  present, preserving the source workspace. Copy snapshots the pasteboard change
  count before filesystem validation and checks it again before commit, so a late
  Copy cannot overwrite a newer clipboard value; a mismatch is reported as a
  recoverable error. Cut remains text-only Pix move data and is limited to the
  same workspace. Browser fallback remains text-only.
  Paste works across project windows
  and independently running Pix instances on the same macOS machine, including
  after changing projects or closing the source window. It copies the current
  source contents at paste time, not a snapshot; deleted/inaccessible sources
  report an operation error. On macOS, Paste also accepts Finder file-URL items:
  an action-triggered native pasteboard snapshot adapts validated local regular
  files and directories from any parent into a bounded version-2 copy batch with
  source workspace `/`. Paste never rewrites the clipboard; ordinary text paths
  remain invalid, while Pix text references remain supported. Reads occur only
  when opening a file menu and on Paste, not by polling; Paste rereads the
  clipboard before mutation. Snapshot changes, stale menu reads, workspace
  replacement and panel teardown cannot apply stale state. Native Copy and Finder
  imports are limited to 1..1000 entries and 32768 encoded bytes. Existing copy/history behavior
  supplies collision-free names, recursive copy and Undo/Redo; selected
  descendants are deduplicated, and unsafe sources/destinations (including
  symlinks, special files, protected history storage and copying a directory into
  itself) are rejected. Browser fallback remains text-only. See
  [decision 0026](../../decisions/0026-cross-instance-file-clipboard.md).
- Copy, cut, paste and duplicate operate on the selected entry group when one is
  selected, otherwise on the focused/context entry. Cut is limited to the same
  workspace; copy may cross workspaces. Group moves, copy, duplicate and delete
  are preflighted as a batch. Conflicts, vanished parents, symbolic links and
  replacements of existing directories are refused; safe-save replacement
  of a regular file is accepted by moving its current contents intact. Cross-
  volume rename does not fall back to copy-and-delete. A late batch failure may
  leave a successful prefix, which is retained as one undoable operation and
  reported as a warning.
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
- Delete requires confirmation and retains the removed data in recovery storage
  for Undo rather than permanently deleting it.
- Pending file I/O does not globally disable Files commands. Mutations use scoped
  reservations; independent forward requests may proceed concurrently. Undo/redo
  replay is disabled/refused until mutations are idle, not queued. Pending document writes finish before a
  mutation and new writes are reserved; a dirty Preview blocks mutation, while a
  clean Preview closes to invalidate stale paths.
  Deletion/rename reserve the affected subtrees; creation keeps its parent directory alive and
  reserves the new path, allowing independent sibling mutations. Copy/paste and
  duplicate conservatively reserve the destination subtree because the backend
  chooses the output name (including partially visible copies). Copying into the
  workspace root therefore excludes other mutations in that root while it runs;
  navigation, opening files and clipboard-reference/path commands remain usable.
  Ignore operations protect the target and possible ancestor `.gitignore` files.
  Conflict checks apply both to menu availability and action activation.
  Files shows active operation labels/counts without a modal progress window.
  Create/rename inline inputs close after submission, before filesystem I/O; failures
  appear in the Files error surface. Each operation owns its completion token;
  finishing one cannot unlock or invalidate another, and workspace replacement
  or panel teardown invalidates all old completions. Late deletion completion
  does not restore tree focus after the user has moved to another row.
  A pending create/rename completion cannot steal focus from a newer name input
  or a different focused tree row; created files open only when that completion
  still owns focus. Name-mutation failures also reach the diagnostic logger.
  See [decision 0028](../../decisions/0028-scoped-file-operation-reservations.md).
- Create, copy, delete, rename and move support Undo/Redo. A group request is one
  history token; partial undo can be retried. Controls are available in the
  toolbar/context menu and via Cmd+Z/Cmd+Shift+Z while Files is focused (not while
  editing a name, searching, or editing Preview text). History is runtime-only
  for the mounted panel and current workspace, with a 100-operation limit.
  Durable recovery data and intent journals live under `.pi/file-history`; they
  are never automatically purged, are excluded from manual and TTL Clean and
  Files tree/search, and nested `.gitignore` files contain `*`. Journals are for
  manual recovery only and are never replayed as executable work after restart.
  A batch that changes nothing removes its own empty token folder, and a copy
  whose staged duplicate cannot be moved into place removes that stage (the
  source is never touched); cleanup failures reach the diagnostic logger.
- Backend history work is serialized per workspace, not process-wide: the
  runtime token map is locked only to look up, insert or forget a token, while
  copies, moves, fsyncs and journal saves hold an in-process lock for the target
  workspace (plus the source workspace for imports and cross-workspace copies,
  acquired all-or-nothing) and the storage `flock` that guards other Pix
  processes. A long copy in one workspace therefore never delays Files
  mutations, Undo/Redo or Forget in another. Forgetting a token while its
  Undo/Redo runs lets that replay finish; later replays are refused.
- The storage `flock` waits up to 750 ms before reporting "Another Pix process
  is changing files". A forked child that has not reached `exec` yet still
  shares the lock's open file description, so a brief busy lock is expected;
  only a lasting one fails the operation. Other lock errors are reported as
  "Failed to lock file history".
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
- Browser fallback retains pointer-based internal Files moves and composer
  references; lazy directory loading is unchanged.
- Project Explorer keeps dotfiles and dotfolders in the normal tree. Entries whose basename starts with `.` use muted opacity by default so ordinary source files retain visual priority; hover, keyboard focus, and selected/open state restore normal readability.
- The workspace-root `.pi` directory, root `AGENTS.md`, direct canonical files in `.pi`, and durable canonical `.pi` directories are emphasized with primary-colored, medium-weight names and `FolderCog`/`FileCog` icons. Canonical entries are limited to the native cleanup allowlists; ephemeral containers such as `artifacts` and `subagents` are excluded. Descendants are not blanket-emphasized, and unknown paths remain unchanged. Emphasized dot entries bypass default muting. Git status name colors retain precedence over emphasis, while icons remain primary-colored; row tooltips describe the entry's role. This is visual-only and does not change focus, navigation or selection.
- Project Explorer colors changed file names from the shared workspace Git snapshot, without displaying status letters or badges. Added/untracked files use success, deleted files warning, conflicts error, and other changes info semantic colors. Working-tree status takes color precedence over staged status; tooltips and accessible row labels describe both scopes. Existing folders containing changed descendants use info-colored names, even when collapsed, with conflicts taking error-color priority. Renames color both source and destination ancestor folders; absent/deleted files are not invented in the filesystem tree. Clean files and unavailable/non-repository snapshots have no decorations.
- While Files is mounted, local Git status refreshes on opening/workspace change, Files Refresh, window focus, file-operation completion, and about every five seconds after the previous read completes. Reads are serialized and repeated triggers coalesce; closing the panel stops scheduling. This reuses the workspace-guarded Git store and does not fetch remotes or traverse/expand the lazy tree. Git errors do not prevent file browsing or change its health indicator.
- While Files is mounted and the window is focused and visible, directory listings
  refresh about every five seconds after the previous poll completes and immediately
  when returning to the window. Only the root and visible expanded directories are
  read, without recursively scanning the project or adding a filesystem watcher.
  Polling preserves existing rows, expansion, selection and focus, skips directories
  already loading, and uses the tree's generation/request guards against stale
  workspace or mutation completions. Cached directory polls are quiet: no loading
  spinner or error clear/reappear cycle while waiting. Successful reads clear old
  errors; initial uncached loads and explicit directory reloads retain loading
  feedback. Equal listings retain array/map identity and do not invalidate tree
  rendering; changed listings reuse unchanged entries. Git polls likewise reuse
  equal snapshots and omit repeated branch/remote listings after metadata bootstrap
  (see [Git status reads](../integrations/desktop-git-workflows.md#explorer-local-status-reads)).
  Background/hidden windows stop scheduling;
  closing Files removes timers and activity listeners. Search results are not polled.
- Expanding a previously loaded directory rereads it and its visible expanded
  descendants, retaining cached rows until completion. Reopening the workspace
  root rereads the root and visible expanded directories. This exposes folders
  created by agents or external tools while a branch was collapsed, without
  waiting for the next poll or scanning unopened branches; in-flight reads coalesce.
- The Files panel keeps a compact project-search field above the lazy tree. Typing a query runs a bounded background search over project-relative file paths and UTF-8 file contents without expanding tree nodes; `Ctrl+Shift+F` / `Cmd+Shift+F` focuses that field while the Files panel is active.
- Project search does not follow symbolic links and skips dependency/generated directories such as `.git`, `node_modules`, `target`, `dist`, `build`, `coverage`, `.next`, and `.svelte-kit`. Individual content reads are bounded to 2 MB, scanning stops after 20,000 files, and at most 500 path/content matches are returned so searching cannot turn the renderer into an unbounded filesystem walk. A newer search from the same window, a cleared query, an unmounted Files panel or a closed window stops the previous walk; unreadable subdirectories are skipped instead of failing the whole search.
- Search results show the relative path, source line/column when the hit came from file contents, and a compact line preview. Activating a content hit opens Preview at that exact source line; activating a path-only hit opens the file normally. Clearing the query returns to the existing lazy tree with its expansion/selection state intact.

## Activity Bar behavior

- **Wiki** opens the project-document tree described in
  [Desktop project Wiki](desktop-project-wiki.md). It shares the rail's keyboard,
  selection, collapse and sizing behavior; documents open in Preview.

- The workspace rail is one vertical toolbar with a single Tab entry anchored to
  the active destination, including when the panel is collapsed. Arrow/Home/End
  navigation moves DOM focus but does not move that Tab entry; returning with Tab
  enters at the active destination rather than the last arrow-focused button.
  This is not a focus-following roving-tabindex implementation.
- The rail is a compact 30 px column with 40 px-high view buttons and 20 px
  icons. Density changes must preserve visible focus and the single-composite
  keyboard model.
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

## Regression coverage

- HTML eligibility and workspace validation.

- Foreground-only polling, focus/visibility resumption, serialized reads, failure retries and teardown during in-flight work. Project Explorer source tests pin the visible-directory refresh and mounted-component lifecycle wiring.

- Composite and type-ahead navigation primitives.

- Visible parent lookup, workspace root naming, nesting, empty/loading rows, and collapse without preference loss.

- Compact per-project expansion persistence, malformed state rejection, and storage bounds.

- Tree semantics and the keyboard external-editor route and emphasized Pix-entry presentation.

- Canonical entry matching and excluded/unknown paths.

- Independent mutations during deferred deletion, ancestor/destination conflicts, partially copied output protection, out-of-order completion and workspace/teardown invalidation.

- Deferred row focus after workspace replacement, teardown and changed focus intent, lazy reverse navigation, pending-list reuse, missing targets and newer reveals, descendant expansion reset on parent/root collapse, persistence and sibling preservation.

- Directory-link routing without Preview changes and stale classification cancellation.

- Captured tab reveal actions and remote-link actions for project Markdown links.

- Directory confinement, file/missing-path rejection and symbolic-link rejection.

- Measured browser-menu bounds, content growth, keyboard anchoring, stale focus work, observer teardown and native host routing/cancellation.

- Shared command policy, awaited eligibility, OS coordinates, serialized registration, stale callbacks, error reporting and idempotent resource release.

- Shared references, format/path validation, cross-project eligibility, text replacement, failures, out-of-order reads and teardown. Native project-entry/copy tests cover recursive cross-workspace copying, preserved source contents, collision naming, exclusive target creation, unsafe destinations and canonical self/descendant rejection.

- Native `git_ignore` tests cover real Git eligibility, literal rules, nested ignore files, append preservation, tracked files/folders with unchanged index contents, and unsafe paths.

- Stale menu/workspace/status reads, teardown invalidation, stable visibility during repeated status refreshes and non-repository failures.

- Staged/working-tree status, conflicts, ancestor aggregation, rename/copy semantics, and clearing snapshots; regression checks cover polling, request coalescing, failed reads, and in-flight teardown.

- Activity Bar composite wiring.

- Native project-search tests cover path/content hits, case-insensitive ASCII matching, ignored dependency directories, and empty queries. The binary-file fixture is not paired with an explicit binary-skipping assertion; that coverage remains a gap. Project Explorer source tests pin the search command, shortcut, bounded result UI, and matched-line Preview navigation.

- `npm --prefix desktop test`

- `npm --prefix desktop run check`

- `npm --prefix desktop run build:web`
