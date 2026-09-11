# Lightweight desktop Markdown rendering

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Implemented; this is the current Desktop Markdown contract.

## Goal

Render Markdown in Desktop transcripts and the workspace Preview editor without adding a large parser or sanitizer dependency.

## Scope

- The Pix Desktop transcript and rendered `.md` file Preview editor.
- Headings, paragraphs, line breaks, emphasis, inline code, safe links, lists, task lists, blockquotes, horizontal rules, fenced code, and simple tables.
- Complete and still-streaming ACP message chunks.
- Preview-editor navigation, embedded media, remote images, and table fitting behavior.
- Markdown content returned by `read` tools when the read target is Markdown.
- Inline previews for supported project/local image and video links in transcript
  Markdown. Supported image extensions are AVIF, BMP, GIF, JPEG, PNG, SVG, and
  WebP; supported video extensions are M4V, MOV, MP4, OGV, and WebM.

## Non-goals

- Full CommonMark or GFM compatibility.
- Rendering raw HTML.
- Treating arbitrary tool output as Markdown; only Markdown `read` results use the
  Markdown renderer.
- Changing table layout or remote-image behavior in regular transcript Markdown.

## Behavior

- User, assistant, thought, and system text use the same Markdown renderer.
- Complete DCP message-id control blocks are removed from rendered transcript
  Markdown. Incomplete control markup remains visible while streaming so the
  renderer fails open instead of hiding ordinary partial text.
- Markdown `read` tool results use the same renderer in a dense tool-result
  presentation; other tool results keep their dedicated plain/code/diff views.
- Raw HTML is always escaped; Markdown never injects executable markup.
- Inline code uses the Desktop semantic accent rather than ordinary prose color.
- Fenced `mermaid` blocks render as diagrams using Mermaid strict security and
  HTML labels disabled. While rendering is pending, or if parsing/rendering
  fails, the escaped source remains readable.
- Explicit Markdown links and bare URLs with `http`, `https`, or `mailto` schemes become links.
- External Markdown links are marked with an external-link icon in both transcripts and the Preview editor.
- Explicit Markdown links with relative destinations and inline-code values that look like relative file paths become project-file links. Inline-code references may carry `:line`, `:start-end`, or `:line:column` suffixes; the column is ignored and the line/range is preserved for preview navigation. Activating a project link reads the target only when its canonical path remains inside the active workspace, then activates the Preview editor with syntax highlighting and line numbers. A preserved line range opens the source view (including for Markdown files), highlights the requested lines, and reveals the first requested line on an otherwise fresh preview entry.
- Explicit Markdown links and inline-code values beginning with `~/` become home-file links. Activating one expands `~` in the trusted Tauri backend, requires the canonical target to remain inside the user's home directory, and opens text or supported media in the existing Preview editor tab.
- Trailing prose punctuation is not included in a bare URL; balanced URL parentheses remain part of it.
- Activating a link delegates it to Tauri's opener plugin so the operating system opens it in the default browser or mail application.
- Unsupported destinations render as plain labels and are never passed to the system opener.
- In a Markdown file Preview editor, project links and local `file://` links use the same trusted preview/open handlers as transcript links. For a project path, the preview first tries the workspace-root interpretation commonly emitted by agents, then falls back to the Markdown document-relative interpretation. Following another preview target pushes/replaces the current Preview editor history entry according to the existing navigation mode.
- In a Markdown file Preview editor, supported project and local images resolve through the existing confined Tauri media commands instead of remaining in a loading state.
- Supported project and absolute `file://` image/video links in transcript
  Markdown render bounded inline media previews with their label as a caption.
  Images lazy-load and open the media viewer when activated; videos expose native
  inline playback controls and their caption opens the viewer.
- `file://` media is accepted only after decoding to an absolute existing regular
  file. The backend canonicalizes it and grants scoped asset access only for a
  supported image/video extension. Non-media `file://` artifacts remain explicit
  clickable links and use the OS opener only after a user action.
- Missing, disallowed, or unrenderable local media keeps a readable fallback and
  actionable caption; a media load failure does not replace the whole transcript
  with a global error.
- Remote `http` and `https` image syntax is embedded only in the Markdown file Preview editor. Remote images do not send a referrer, and linked remote images retain their safe local or external destination behavior.
- In a Markdown file Preview editor, tables use the available content width and wrap long cell content rather than creating a horizontal table scrollbar. Transcript tables retain horizontal scrolling.
- Internal preview navigations push file or media entries onto a browser-like history stack inside the single Preview editor tab. Back and forward controls traverse that stack; following a new link after going back discards the old forward branch. Opening a preview from outside Preview starts a new history and activates the Preview tab; closing the Preview editor clears the history.
- Each preview history entry retains its horizontal and vertical scroll position, which is restored when Back or Forward returns to that entry.
- Preview consumes the central editor region rather than a resizable modal. Switching to Conversation or Git Diff leaves the still-open Preview component mounted so its current edit draft and scroll/history state are not reset merely by editor switching.
- Same-document hash links in a Markdown preview scroll to stable, deduplicated heading anchors.
- Raw absolute paths, URL-like destinations other than the separately supported `file://` flow, parent-directory traversal, directories, binary/non-UTF-8 text files, and files larger than the preview limit are not previewed.
- An unclosed fenced code block remains visible while the message streams.
- Code and tables may scroll horizontally instead of widening the transcript.
- Markdown parsing uses a small local parser rather than a parser/sanitizer runtime dependency.

## Related files

- `desktop/src/lib/markdown.ts`
- `desktop/src/lib/markdown.test.ts`
- `desktop/src/lib/preview-history.ts`
- `desktop/src/lib/preview-history.test.ts`
- `desktop/src/lib/project-files.ts`
- `desktop/src/lib/external-links.ts`
- `desktop/src/lib/external-links.test.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/ToolResult.svelte`
- `desktop/src/components/PreviewPane.svelte`
- `desktop/src/components/WorkspaceEditorTabs.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/lib/mermaid.ts`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`
- `desktop/src-tauri/tauri.conf.json`

## Verification

- Unit tests cover supported blocks, inline formatting, bare URLs, relative
  project-file links and inline-code line-range extraction, remote-image opt-in/default behavior, linked images,
  unsafe input, DCP control-block stripping/fail-open streaming behavior,
  Mermaid fallback/security, and incomplete fences.
- Rust tests cover workspace/home confinement and preview size/UTF-8 validation.
- Rust tests also cover project/absolute media confinement, traversal, unsupported
  local binary files, and allowed media resolution.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.

## Risks / unknowns

- Deliberately unsupported CommonMark edge cases remain literal or degrade to plain text.
- Bare domains without an explicit supported scheme remain plain text.
- Previewing Markdown with remote images can make network requests to hosts named by the document; transcript Markdown remains non-fetching by default.

## Evidence

- Confirmed by code: `MarkdownText.svelte` and `desktop/src/lib/markdown.ts`
  render transcript and preview Markdown; `ToolResult.svelte` opts Markdown read
  results into the same renderer.
- Confirmed by code: `desktop/src/lib/mermaid.ts` uses strict Mermaid security,
  disables HTML labels, and preserves a readable source fallback on failure.
- Confirmed by tests: `desktop/src/lib/markdown.test.ts` exercises the supported
  parser/link/table/media/streaming surface.
- Confirmed by Rust tests: project/home/local media resolution remains confined
  to the trusted backend paths and size/UTF-8 limits.
