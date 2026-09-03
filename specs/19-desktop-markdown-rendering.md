# Spec: Lightweight desktop Markdown rendering

## Type

Change

## Goal

Render Markdown in Desktop user messages, assistant messages, and assistant thoughts without adding a large parser or sanitizer dependency.

## Scope

- The Pix Desktop transcript only.
- Headings, paragraphs, line breaks, emphasis, inline code, safe links, lists, task lists, blockquotes, horizontal rules, fenced code, and simple tables.
- Complete and still-streaming ACP message chunks.

## Non-goals

- Full CommonMark or GFM compatibility.
- Raw HTML, embedded media, or Mermaid.
- Markdown rendering for tool output.

## Behavior

- User, assistant, and thought text use the same Markdown renderer.
- Raw HTML is always escaped; Markdown never injects executable markup.
- Explicit Markdown links and bare URLs with `http`, `https`, or `mailto` schemes become links.
- Explicit Markdown links with relative destinations and inline-code values that look like relative file paths become project-file links. Activating one reads the target only when its canonical path remains inside the active workspace, then opens its source in the preview dialog with syntax highlighting and line numbers.
- Trailing prose punctuation is not included in a bare URL; balanced URL parentheses remain part of it.
- Activating a link delegates it to Tauri's opener plugin so the operating system opens it in the default browser or mail application.
- Unsupported destinations render as plain labels and are never passed to the system opener.
- Absolute paths, URL-like destinations, parent-directory traversal, directories, binary/non-UTF-8 files, and files larger than the preview limit are not previewed.
- An unclosed fenced code block remains visible while the message streams.
- Code and tables may scroll horizontally instead of widening the transcript.
- Markdown parsing uses a small local parser rather than a parser/sanitizer runtime dependency.

## Related files

- `desktop/src/lib/markdown.ts`
- `desktop/src/lib/markdown.test.ts`
- `desktop/src/lib/external-links.ts`
- `desktop/src/lib/external-links.test.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/PreviewDialog.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/App.svelte`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/capabilities/default.json`

## Verification

- Unit tests cover supported blocks, inline formatting, bare URLs, relative project-file links, unsafe input, system-opener delegation, and incomplete fences.
- Rust tests cover workspace confinement and preview size/UTF-8 validation.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.

## Risks / unknowns

- Deliberately unsupported CommonMark edge cases remain literal or degrade to plain text.
- Bare domains without an explicit supported scheme remain plain text.

## Evidence

- Confirmed by code: Desktop currently interpolates all three message roles as plain text.
- Confirmed by package manifest: Desktop has no Markdown parser or HTML sanitizer dependency.
- Confirmed by design contract: assistant content should prioritize readability while thoughts and technical content visually recede.
