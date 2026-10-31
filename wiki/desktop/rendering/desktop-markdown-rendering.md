---
kind: spec
status: active
---

# Lightweight desktop Markdown rendering

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Implemented; this is the current Desktop Markdown contract.

## Goal

Render Markdown in Desktop transcripts and the workspace Preview editor without adding a general-purpose Markdown parser or sanitizer dependency.

## Scope

- The Pix Desktop transcript and rendered `.md` file Preview editor.
- Headings, paragraphs, line breaks, emphasis, inline code, safe links, lists, task lists, blockquotes, horizontal rules, fenced code, and simple tables.
- Inline and display LaTeX formulas via the dedicated [math Markdown spec](../../rendering/math-markdown-rendering.md).
- Complete and still-streaming ACP message chunks.
- Preview-editor navigation, embedded media, remote images, and table fitting behavior.
- Markdown content returned by `read` tools when the read target is Markdown.
- Inline previews for supported project/local image, video, audio and GLB links in transcript
  Markdown. Supported image extensions are AVIF, BMP, GIF, JPEG, PNG, SVG, and
  WebP; supported video extensions are M4V, MOV, MP4, OGV, and WebM. Models use `.glb`.
  Audio extensions are AAC, AIF/AIFF, FLAC, M4A, MP3, OGA/OGG, Opus and WAV;
  playback depends on the macOS WebView's codec support.

## Non-goals

- Full CommonMark or GFM compatibility.
- Rendering raw HTML.
- Executing raw HTML inside the Markdown renderer. Explicit assistant-only
  `pix-html` fences use a separate opt-in iframe sandbox instead; see
  [interactive HTML sandbox](desktop-html-sandbox.md).
- Treating arbitrary tool output as Markdown; only Markdown `read` results use the
  Markdown renderer.
- Fetching remote images in regular transcript Markdown.

## Behavior

- User, assistant, thought, and system text use the same Markdown renderer.
- Complete DCP message-id control blocks are removed from rendered transcript
  Markdown. Incomplete control markup remains visible while streaming so the
  renderer fails open instead of hiding ordinary partial text.
- Markdown `read` tool results use the same renderer in a dense tool-result
  presentation; other tool results keep their dedicated plain/code/diff views.
- Raw HTML is always escaped; Markdown never injects executable markup.
- Underscores inside words, identifiers and filenames remain literal, including
  Markdown link labels and media captions (`01_M_Supertonic_M1.mp3`). Standalone
  `_emphasis_`, `__strong__` and `___both___` use whitespace/punctuation-aware
  opening and closing boundaries; escaped or unclosed underscores stay readable.
- Markdown headings use the semantic warning accent mixed with the foreground so
  their hierarchy stays prominent with a restrained warm tone in both themes.
- Inline code uses the Desktop semantic accent rather than ordinary prose color.
- Fenced `mermaid` blocks render as diagrams using Mermaid strict security and
  HTML labels disabled. While rendering is pending, or if parsing/rendering
  fails, the escaped source remains readable.
- Recognized LaTeX math delimiters use KaTeX with bundled fonts; code spans and
  fences remain literal, and malformed/streaming formulas retain escaped source.
- Explicit Markdown links and bare URLs with `http`, `https`, or `mailto` schemes become links.
- A standalone `http://`, `https://`, or `mailto:` URL inside inline code also
  becomes an external link, preserving its code styling and full destination
  (including localhost ports, queries, and fragments). Inline code containing
  commands or whitespace, fenced code, and unsupported schemes remain literal;
  code labels inside explicit Markdown links do not gain nested links.
- Relative project links may also name existing directories. Activation uses
  Files reverse navigation instead of Preview or the OS opener: open the panel,
  clear search, expand ancestors and the folder, select and scroll to it while
  retaining the project tree root. Directory validation stays workspace-confined
  and rejects symlinks. The same workspace-root-first resolution applies inside
  Markdown Preview. See [workspace navigation](../workbench/desktop-workspace-navigation.md)
  and [decision 0058](../../decisions/0058-reverse-file-navigation.md).
- Inline-code relative paths ending in `/` (or `\`) are directory-link
  candidates even without a file extension or `./` prefix, including hidden
  paths such as `.pi/artifacts/usage-popup-mockups/`. Preserve the displayed
  code text, normalize the target, and make it clickable only after the existing
  workspace-confined existence validation succeeds. Missing or rejected targets
  remain ordinary inline code.
- External Markdown links are marked with an external-link icon in both transcripts and the Preview editor.
- Successfully validated project and home/local file links prepend a decorative,
  aria-hidden Lucide icon classified by destination extension (HTML `.html` and
  `.htm` files, case-insensitively, use Globe; code/config,
  text/Markdown, image, audio, video, archive, PDF, or generic file). Validated
  project and absolute local directories use the Folder icon based on validation
  metadata, including directories whose names contain dots. Missing or otherwise
  unvalidated candidates remain plain labels without a file icon. External links
  retain their existing trailing external-link icon. Icons do not replace link
  labels or navigation/line-range metadata; shared `MarkdownText` applies this in
  transcripts and Preview. Lazy validation preserves the file/directory kind;
  Preview resolves project targets workspace-root-first, then document-relative.
  Home-directory links retain their existing behavior; home directories are not
  supported as directory links.
- Explicit Markdown links with relative destinations and inline-code values that look like relative file paths become project-file links. Explicit links preserve GitHub-style `#Lline` and `#Lstart-Lend` fragments as source line ranges; other fragments remain ordinary fragment-free project links. Inline-code references may carry `:line`, `:start-end`, or `:line:column` suffixes; the column is ignored and the line/range is preserved for preview navigation. Activating a project link reads the target only when its canonical path remains inside the active workspace, then activates the Preview editor with syntax highlighting and line numbers. A preserved line range opens the source view (including for Markdown files), highlights the requested lines, and reveals the first requested line on an otherwise fresh preview entry.
- Explicit Markdown links and inline-code values beginning with `~/` become home-file links. Activating one expands `~` in the trusted Tauri backend, requires the canonical target to remain inside the user's home directory, and opens text or supported media in the existing Preview editor tab.
- Trailing prose punctuation is not included in a bare URL; balanced URL parentheses remain part of it.
- Activating an external link delegates it to Tauri's opener plugin so the operating system opens it in the default browser or mail application.
- Unsupported destinations render as plain labels and are never passed to the system opener.
- In a Markdown file Preview editor, project links and local `file://` links use the same trusted preview/open handlers as transcript links. For a project path, the preview first tries the workspace-root interpretation commonly emitted by agents, then falls back to the Markdown document-relative interpretation. Following another preview target pushes/replaces the current Preview editor history entry according to the existing navigation mode.
- In a Markdown file Preview editor, supported project and local images resolve through the existing confined Tauri media commands instead of remaining in a loading state.
- Supported project, raw absolute and absolute `file://` image/video links in transcript
  Markdown render bounded inline media previews with their label as a caption.
  Images lazy-load and open the media viewer when activated; videos expose native
  inline playback controls and their caption opens the viewer.
- Inline video backgrounds, including WebKit's native paused-player backdrop,
  use the semantic Desktop background in both light and dark themes.
- Local audio links in both `[label](../../../specs/track.mp3)` and `![label](../../../specs/track.mp3)` syntax
  embed a compact native audio player with accessible label, playback/seek controls
  and an actionable caption that opens the same audio in the existing Preview tab.
  Project, raw absolute, absolute `file://`, and `~/` destinations use the existing
  trusted media resolvers. Audio files opened from Files or file attachments also
  show a player in Preview rather than a UTF-8 editor or OS-opener fallback.
  Inline players load metadata without autoplay and expose native controls.
  Opening audio or video from the Files panel requests immediate playback once
  the resolved Preview player mounts. Other entry points and Preview history do
  not autoplay; rejected playback leaves native controls available. Preview audio
  and video pause when hidden, never auto-resume on return, and release their
  source on navigation/close, including late playback completions.
  Audio remains a plain `file` attachment for model/provider prompt handling.
- Audio recognition is case-insensitive and shared by Markdown and Preview:
  `.aac`, `.aif`, `.aiff`, `.flac`, `.m4a`, `.m4b`, `.mp3`, `.mpga`, `.oga`,
  `.ogg`, `.opus`, `.wav`, `.wave`, and `.weba`. M4B uses MP4 audio, MPGA uses
  MPEG audio, WAVE uses WAV audio, and WEBA uses WebM audio. Recognition routes
  files to the player; most codec playback depends on the macOS WebView and
  system version. Ogg Vorbis and Ogg Opus (`.ogg`, `.oga`, `.opus`) additionally
  have an offline compatibility decoder: if native playback reports an
  unsupported source (or a decode error before metadata), a bundled WASM decoder
  converts it to 16-bit PCM WAV in a
  dedicated worker. Markdown and Preview share this path and retain native audio
  controls. The decoder initializes playback on metadata or can-play readiness;
  a user's play intent survives one native-to-decoded fallback. Files autoplay
  is consumed when the player mounts and does not restart on same-key source
  updates. No external FFmpeg installation or network download is required.
  Compatibility jobs are serialized and limited to 32 MiB compressed input,
  64 MiB decoded float PCM (about 175 seconds at 48 kHz stereo) and 30 seconds
  per active worker. Inline hydration is already viewport-lazy, including audio.
  Closing/removing or changing the source cancels queued/active work and releases
  decoded object URLs. Worker message errors are handled as decoder failures.
  A pending Files autoplay survives decoding, but hiding the tab cancels that
  intent so returning never starts playback. Final decoding/size/timeout failures
  retain the existing readable unavailable state and emit a warning diagnostic
  (`media:playback-unavailable`); the recoverable fallback attempt is debug-level
  (`media:ogg-fallback`). Diagnostic messages omit stack traces and media paths.
- Unchanged inline audio players retain their actual DOM and playback position
  through streaming updates, including pending resolution and error state, using
  the same original-markup/occurrence identity policy as local images. Duplicate
  occurrences own separate players. Removal, source changes and teardown pause
  audio and release its source; stale resolver completions cannot attach a player.
  Preview audio pauses when switching away from its tab, does not resume
  automatically on return, and releases its source on navigation or close.
  Unsupported codecs or damaged audio show a readable local error. Remote audio
  is not embedded or fetched, including with Preview's remote-image opt-in.
- Inline-code absolute image/video paths (including `file://` destinations) also
  produce the same lazy local previews, with the original code-formatted path as
  caption. They use the existing trusted local-media resolver; missing files,
  directories and unsupported formats do not gain direct WebView file access.
  Ordinary absolute text/file paths remain validation candidates, and paths in
  fenced code or Markdown link labels do not create nested previews.
- Project/local Markdown images reserve their known intrinsic proportions through
  loading, errors, and streaming rerenders. In chat they use the full available
  content width, bounded by the scroll pane's visible height and intrinsic image
  width, without cropping or upscaling. The height bound updates on pane resize
  (including composer resizing); hidden panes retain their last positive height.
  Inline project/local videos use the same content-width and viewport-height
  bounds, keeping natural proportions and native playback controls. Outside chat
  the existing 48rem container and 28rem height caps remain. Remote images and
  attachment thumbnails are unchanged. Unknown image dimensions use
  a compact fallback until first load, not a fixed square.
  See [Desktop transcript scrolling](desktop-transcript-scrolling.md).
- Unchanged project/local image previews retain their actual DOM subtree across
  streaming HTML updates, including pending resolution, loaded images and error
  state. Restoration happens before lazy observers run, without a new image load
  or an intermediate empty frame. Identity includes the original preview markup
  (scope, path and caption); duplicate occurrences remain distinct. Removed or
  changed previews are not resurrected, and teardown releases retained nodes.
  Videos and remote images are outside this retention policy.
  See [image retention decision](../../decisions/0016-streaming-image-dom-retention.md).
- Media path resolution is cached per rendered Markdown block (shared by all its
  segments, so one file resolves once) and released only when its last segment
  unmounts. Only successful resolutions are cached: a missing or failed
  resolution is evicted once it settles, so a later occurrence of the same path
  (for example after the agent writes a file it mentioned earlier) resolves
  again instead of reusing "Preview unavailable". An occurrence already in the
  error state keeps it through streaming as described above.
- `file://` media is accepted only after decoding to an absolute existing regular
  file. The backend canonicalizes it and grants scoped asset access only for a
  supported image/video/audio/GLB extension. Existing bounded UTF-8 non-media files from
  `file://`, raw absolute Markdown destinations, or inline-code absolute paths
  open read-only in the Desktop Preview. Absolute directories and small
  binary/non-UTF-8 files retain the OS-opener fallback after user action.
  Missing paths remain ordinary text.
- Interactive non-media file opens (project, `~/`, and absolute local paths)
  use a backend bounded read before sending content to the WebView. Files over
  256 KiB or 2,000 source lines open in the configured external editor instead
  of Preview; no pagination, content transfer, Preview history entry, or tab
  activation is performed for these files. Metadata is checked first, and reads
  are capped at 256 KiB plus one byte to catch concurrent growth. A newline
  contributes one additional source line, including a trailing empty line.
  Path confinement is revalidated before editor launch. If no editor is
  configured, an actionable Settings → Desktop → Editor message is shown;
  launch failures are reported without silently switching to the OS opener.
  Stale read/settings completions after navigation, close, or workspace changes
  cannot launch an editor. Existing config reads/writes retain their own limits.
- Missing, disallowed, or unrenderable local media keeps a readable fallback and
  actionable caption; a media load failure does not replace the whole transcript
  with a global error.
- Local GLB 2.0 Markdown links to `models/chair.glb` (or absolute/file URI or `~/` paths)
  embed an interactive 3D viewer. Left-button drag rotates freely through a full
  vertical revolution, including both poles, without an angle stop or upright
  snap. Middle-button drag
  pans the view without zooming, wheel/pinch zooms, keyboard arrows
  rotate without the vertical angle stop and plus/minus zoom; Reset camera fits
  the model and restores its upright orientation. The caption opens the
  same model in Preview. Remote GLB links remain ordinary external links.
- GLB uses a lazily imported Three.js renderer with demand-driven drawing, not a
  continuous animation loop. Identical model occurrences retain their DOM and
  camera through streaming updates, while duplicates own separate viewers.
  Returning from Preview (including closing its tab) or another hidden workbench
  panel repaints the retained inline model without reloading it or resetting its
  camera. Drawing is coalesced into one requested animation frame after layout;
  hidden zero-sized viewports do not replace the last visible camera aspect.
  Removal, source changes and teardown abort reads and release controls, resize
  and visibility observers, pending draws, GPU resources, decoded image bitmaps
  and WebGL contexts; late parse
  completion is discarded and disposed.
- WebKit caps active WebGL contexts and silently evicts the oldest, so a
  transcript model holds a renderer only while within 320 px of the viewport.
  About 1.5 seconds after it leaves, the viewer is released (its frame keeps its
  size); re-entry reloads the model with a freshly fitted camera. Preview's
  single viewer is not viewport-scoped. If the browser still drops a live
  context (`webglcontextlost`), the viewer releases the scene, logs a warning to
  the diagnostic logger and shows a paused state with a **Reload 3D preview**
  button.
- GLB preview caps streamed input at 64 MiB and requires embedded resources.
  Asset files are fetched only with bounded single Range requests, checking
  Content-Range totals before allocating the model buffer; oversized native
  files never take Tauri's unrestricted full-file asset read path.
  Metadata nesting beyond 128 levels is rejected. Three.js parser work already
  in progress cannot be interrupted; resource reads abort where supported and
  stale parsed scenes are disposed without attaching to the UI.
  External resource URIs are rejected before parsing; runtime loading permits
  only embedded data/blob URLs. Invalid files, unavailable WebGL and required
  Draco/Basis/Meshopt decoders show a readable error instead of fetching sidecars
  or external decoder scripts. Model animations do not auto-play.
- Remote `http` and `https` image syntax is embedded only in the Markdown file Preview editor. Remote images do not send a referrer, and linked remote images retain their safe local or external destination behavior.
- Right-clicking an image in Markdown or the Preview tab offers Copy Image and
  Open Image in External App through the shared native context menu (see
  `wiki/desktop/workbench/desktop-context-menus.md`).
- In the Markdown Preview editor, transcript messages, and Markdown `read`
  results, tables use the available content width and
  wrap cell text at word boundaries. Intrinsic column sizing preserves whole
  words and inline-code identifiers (for example, `station` must not become
  `statio` / `n` just to narrow a column). Exceptionally wide tables retain a
  horizontal scroll fallback rather than overflowing the containing surface.
  Renderer callers that do not opt into fitting retain intrinsic-width tables
  with horizontal scrolling.
- Internal preview navigations push file or media entries onto a browser-like history stack inside the single Preview editor tab. Back and forward controls traverse that stack; following a new link after going back discards the old forward branch. Opening a preview from outside Preview starts a new history and activates the Preview tab; closing the Preview editor clears the history.
- Each preview history entry retains its horizontal and vertical scroll position, which is restored when Back or Forward returns to that entry. Wiki search-range navigation also retains the range on its Preview entry.
- Source-range annotations are opt-in for rendered Markdown. In Wiki Preview,
  search results provide a source fragment range separately from the existing
  source-view line range. The renderer annotates top-level Markdown blocks with
  their original one-based source lines; hidden DCP control metadata preserves
  source positions when omitted. Preview highlights blocks intersecting the
  fragment and schedules reveal after saved-scroll restoration. Search-range
  highlighting leaves the document rendered as Markdown; ordinary source links
  retain source-view navigation and line highlighting. Preview history retains
  the search range with each entry, and stale/cancelled reveal work is ignored.
- Preview consumes the central workbench region rather than a resizable modal. Switching to a conversation or Git Diff tab in the unified top strip leaves the still-open Preview component mounted so its current edit draft and scroll/history state are not reset merely by tab switching.
- Same-document hash links in a Markdown preview scroll to stable, deduplicated heading anchors.
- Unvalidated raw absolute prose, URL-like destinations other than the supported local-file flow, parent-directory traversal, directories, binary/non-UTF-8 text files, and files larger than the preview limit are not previewed.
- An unclosed fenced code block remains visible while the message streams.
- Every fenced code block has a keyboard-accessible Copy code button in its top-right corner, including visible Mermaid source fallbacks. It copies only the raw code body (no fences, language label, or highlighting markup), preserving indentation and line breaks. The button briefly shows Copied after success or Copy failed on clipboard errors. Rerenders and teardown cancel feedback timers and ignore stale clipboard completions. Inline code and prose do not gain buttons.
- The copy control is a fixed 24×24 px square with a centered icon; feedback is
  positioned beside it without changing the button size.
- Fenced code keeps its intrinsic width for short content (with a compact minimum
  reserving room for the copy control and adjacent feedback, never wider than the container) and is capped at the
  available content width. Long logical lines visually wrap without horizontal
  scrolling while preserving whitespace, source line breaks, and syntax
  highlighting. Exceptionally wide tables retain their horizontal scroll fallback.
- Shared source/fenced-code highlighting skips tokenization for blocks larger than 32,768 UTF-16 code units and for unknown/plaintext languages. These blocks remain fully escaped, untruncated plaintext with the same per-line structure, preserving source line numbers and line-range navigation without generating token markup for the whole large input.
- Markdown parsing uses a small local parser rather than a parser/sanitizer runtime dependency.

## Implementation

- `desktop/src/lib/markdown.ts`
- `desktop/src/lib/markdown-blocks.ts`
- `desktop/src/lib/markdown-context.ts`
- `desktop/src/lib/markdown-dcp.ts`
- `desktop/src/lib/markdown-escape.ts`
- `desktop/src/lib/markdown-fences.ts`
- `desktop/src/lib/markdown-inline.ts`
- `desktop/src/lib/markdown-math.ts`
- `desktop/src/lib/markdown-links.ts`
- `desktop/src/lib/media.ts`
- `desktop/src/lib/attachments.ts`
- `desktop/src/lib/syntax-highlight.ts`
- `desktop/src/lib/preview-history.ts`
- `desktop/src/lib/project-files.ts`
- `desktop/src/lib/external-links.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/markdown-file-link.ts`
- `desktop/src/lib/file-link-kind.ts`
- `desktop/src/components/file-link-validation-cache.ts`
- `desktop/src/components/markdown-content-action.ts`
- `desktop/src/components/markdown-image-retention.ts`
- `desktop/src/components/audio-playback-action.ts`
- `desktop/src/components/markdown-code-copy-action.ts`
- `desktop/src/components/markdown-link-action.ts`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/preview-markdown-controller.svelte.ts`
- `desktop/src/components/preview-scroll-controller.svelte.ts`
- `desktop/src/components/WorkbenchTabs.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/lib/mermaid.ts`
- `desktop/src/app/preview.svelte.ts`
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src-tauri/src/project_directory_link.rs`
- `desktop/src/app/preview-options.ts`
- `desktop/src/app/desktop-project-services.ts`
- `desktop/src-tauri/src/preview_file.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/lib/glb.ts`
- `desktop/src/lib/glb-scene.ts`
- `desktop/src/lib/glb-controls.ts`
- `desktop/src/lib/glb-source.ts`
- `desktop/src/components/glb-viewer-action.ts`
- `desktop/src/styles/glb-viewer.css`
- `desktop/package.json`
- `desktop/package-lock.json`

## Tests

- `desktop/src/components/MarkdownText.test.ts`
- `desktop/src/components/markdown-file-link.test.ts`
- `desktop/src/lib/file-link-kind.test.ts`
- `desktop/src/components/file-link-validation-cache.test.ts`
- `desktop/src/lib/markdown.test.ts`
- `desktop/src/lib/media.test.ts`
- `desktop/src/components/audio-playback-action.test.ts`
- `desktop/src/lib/glb.test.ts`
- `desktop/src/lib/glb-scene.test.ts`
- `desktop/src/lib/glb-controls.test.ts`
- `desktop/src/lib/glb-source.test.ts`
- `desktop/src/components/glb-viewer-action.test.ts`
- `desktop/src/components/markdown-image-layout.test.ts`
- `desktop/src/lib/syntax-highlight.test.ts`
- `desktop/src/lib/preview-history.test.ts`
- `desktop/src/lib/external-links.test.ts`
- `desktop/src/components/markdown-table-layout.test.ts`
- `desktop/src/components/markdown-code-copy-action.test.ts`
- `desktop/src/components/preview-scroll-controller.test.ts`
- `desktop/src/app/preview.test.ts`
- `desktop/src/app/desktop-workbench-prop-builders.test.ts`
- `desktop/src-tauri/src/project_directory_link.rs`
- `desktop/src-tauri/src/lib.rs`

## Verification

- Unit tests cover supported blocks, inline formatting, bare URLs, relative
  project-file links and inline-code line-range extraction, remote-image opt-in/default behavior, linked images,
  unsafe input, DCP control-block stripping/fail-open streaming behavior,
  Mermaid fallback/security, and incomplete fences.
- Rust tests cover workspace/home confinement and preview size/UTF-8 validation.
- Audio tests cover both Markdown syntaxes/path scopes, MIME/Preview classification,
  confined backend resolution, player retention/duplicates, stale completions,
  removal/teardown, inactive-tab pausing and readable media errors. Unit tests do
  not establish actual macOS codec availability or audible playback.
- Interactive-preview Rust tests cover byte/line boundaries, sparse oversize
  files, bounded growth classification, small text, and project/home/absolute
  targets. Preview-store tests cover configured-editor routing, missing/failed
  editors, preserved small-file line ranges/history, and stale read/preferences.
- Syntax-highlighting tests cover the large-source fallback, escaped markup, retained empty/CRLF lines, and unchanged small-source highlighting.
- Preview-scroll tests cover ordering the requested line reveal after pending
  saved-position restoration and cancelling stale scheduled reveals.
- Table-style source-contract tests guard word-preserving intrinsic column sizing,
  fitting and intrinsic-width styles, and the horizontal scroll fallback. These
  assertions do not exercise caller opt-in or real UI layout; transcript and
  Markdown tool-result fitting is confirmed by their renderer props.
- Rust tests also cover project/absolute media confinement, traversal, unsupported
  local binary files, and allowed media resolution.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.

## Risks / unknowns

- Deliberately unsupported CommonMark edge cases remain literal or degrade to plain text.
- Bare domains without an explicit supported scheme remain plain text.
- Previewing Markdown with remote images can make network requests to hosts named by the document; transcript Markdown remains non-fetching by default.
- Audio extension recognition does not guarantee that each encoding is playable
  on every supported macOS WebView; unavailable codecs keep a readable fallback.

## Evidence

- Confirmed by code: `MarkdownText.svelte` owns the rendered shell while its DOM
  content/link actions own lazy validation, media/Mermaid hydration, external-link
  decoration, and delegated link activation. The `desktop/src/lib/markdown.ts`
  facade and its block/inline/link/DCP helper modules build the safe transcript and
  preview markup; `ToolResult.svelte` opts Markdown read results into the same renderer.
- Confirmed by code: `desktop/src/lib/mermaid.ts` uses strict Mermaid security,
  disables HTML labels, and preserves a readable source fallback on failure.
- Confirmed by tests: `desktop/src/lib/markdown.test.ts` exercises the supported
  parser/link/table/media/streaming surface.
- Confirmed by Rust tests: project/home/local media resolution remains confined
  to the trusted backend paths and size/UTF-8 limits.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"b5c5011bb09f7e81b9f8c4fc57878be1f154a8250dd5529d3878a9e2879fa6cc","checkedAt":"2026-10-31T02:09:38.943Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":68,"reportLanguage":"ru"} -->
