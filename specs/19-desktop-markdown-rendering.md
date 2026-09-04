# Spec: Lightweight desktop Markdown rendering

## Type

Change

## Goal

Render Markdown in Desktop transcripts and Markdown file previews without adding a large parser or sanitizer dependency.

## Scope

- The Pix Desktop transcript and rendered `.md` file preview popup.
- Headings, paragraphs, line breaks, emphasis, inline code, safe links, lists, task lists, blockquotes, horizontal rules, fenced code, and simple tables.
- Complete and still-streaming ACP message chunks.
- Popup-only navigation, embedded media, remote images, and table fitting behavior.

## Non-goals

- Full CommonMark or GFM compatibility.
- Rendering raw HTML.
- Markdown rendering for tool output.
- Changing table layout or remote-image behavior in regular transcript Markdown.

## Behavior

- User, assistant, and thought text use the same Markdown renderer.
- Raw HTML is always escaped; Markdown never injects executable markup.
- Explicit Markdown links and bare URLs with `http`, `https`, or `mailto` schemes become links.
- External Markdown links are marked with an external-link icon in both transcripts and preview popups.
- Explicit Markdown links with relative destinations and inline-code values that look like relative file paths become project-file links. Activating one reads the target only when its canonical path remains inside the active workspace, then opens its source in the preview dialog with syntax highlighting and line numbers.
- Explicit Markdown links and inline-code values beginning with `~/` become home-file links. Activating one expands `~` in the trusted Tauri backend, requires the canonical target to remain inside the user's home directory, and opens text or supported media in the existing preview dialog.
- Trailing prose punctuation is not included in a bare URL; balanced URL parentheses remain part of it.
- Activating a link delegates it to Tauri's opener plugin so the operating system opens it in the default browser or mail application.
- Unsupported destinations render as plain labels and are never passed to the system opener.
- In a Markdown file preview popup, relative project links and local `file://` links use the same trusted preview/open handlers as transcript links. Opening another preview replaces the current popup content.
- In a Markdown file preview popup, supported project and local images resolve through the existing confined Tauri media commands instead of remaining in a loading state.
- Remote `http` and `https` image syntax is embedded only in the Markdown file preview popup. Remote images do not send a referrer, and linked remote images retain their safe local or external destination behavior.
- In a Markdown file preview popup, tables use the available content width and wrap long cell content rather than creating a horizontal table scrollbar. Transcript tables retain horizontal scrolling.
- Internal preview navigations push file or media entries onto a browser-like history stack. Back and forward controls traverse that stack; following a new link after going back discards the old forward branch. Opening a preview from outside the popup starts a new history and closing it clears the history.
- Each preview history entry retains its horizontal and vertical scroll position, which is restored when Back or Forward returns to that entry.
- The preview popup keeps its current dimensions while navigating between files and media instead of shrinking to fit the next entry's content. User resizing remains in effect for the lifetime of the open popup.
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
- `desktop/src/lib/external-links.ts`
- `desktop/src/lib/external-links.test.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/PreviewDialog.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`
- `desktop/src-tauri/tauri.conf.json`

## Verification

- Unit tests cover supported blocks, inline formatting, bare URLs, relative project-file links, remote-image opt-in/default behavior, linked images, unsafe input, system-opener delegation, and incomplete fences.
- Rust tests cover workspace/home confinement and preview size/UTF-8 validation.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.

## Risks / unknowns

- Deliberately unsupported CommonMark edge cases remain literal or degrade to plain text.
- Bare domains without an explicit supported scheme remain plain text.
- Previewing Markdown with remote images can make network requests to hosts named by the document; transcript Markdown remains non-fetching by default.

## Evidence

- Confirmed by code: Desktop currently interpolates all three message roles as plain text.
- Confirmed by package manifest: Desktop has no Markdown parser or HTML sanitizer dependency.
- Confirmed by design contract: assistant content should prioritize readability while thoughts and technical content visually recede.
- Confirmed by the reported failure: `~/.config/pi/pix.jsonc` was previously passed to the project-file resolver and looked up beneath the workspace without expanding `~`.
