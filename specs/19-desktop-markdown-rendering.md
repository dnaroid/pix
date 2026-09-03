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
- Raw HTML, embedded media, Mermaid, or syntax highlighting.
- Markdown rendering for tool output.

## Behavior

- User, assistant, and thought text use the same Markdown renderer.
- Raw HTML is always escaped; Markdown never injects executable markup.
- Only `http`, `https`, and `mailto` destinations become links. Unsupported destinations render as plain labels.
- An unclosed fenced code block remains visible while the message streams.
- Code and tables may scroll horizontally instead of widening the transcript.
- Rendering uses a small local parser and adds no runtime dependency.

## Related files

- `desktop/src/lib/markdown.ts`
- `desktop/src/lib/markdown.test.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/TranscriptPane.svelte`

## Verification

- Unit tests cover supported blocks, inline formatting, unsafe input, and incomplete fences.
- `npm run test`, `npm run check`, and `npm run build:web` pass in `desktop/`.

## Risks / unknowns

- Deliberately unsupported CommonMark edge cases remain literal or degrade to plain text.
- External-link handoff behavior depends on the Tauri WebView and is outside this renderer change.

## Evidence

- Confirmed by code: Desktop currently interpolates all three message roles as plain text.
- Confirmed by package manifest: Desktop has no Markdown parser or HTML sanitizer dependency.
- Confirmed by design contract: assistant content should prioritize readability while thoughts and technical content visually recede.
