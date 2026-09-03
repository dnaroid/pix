# Desktop Markdown rendering

## Type

Change specification.

## Goal

Render assistant, user, thought, and Markdown tool content consistently in the desktop transcript.

## Behavior

- Support headings, paragraphs, bold, italic, bold-italic, strikethrough, inline code, fenced code, links, blockquotes, horizontal rules, ordered/unordered/task lists, and GFM-style tables with alignment.
- Give inline code (text wrapped in backticks) a distinct semantic accent color.
- Render fenced `mermaid` blocks as diagrams. Until rendering completes, and if rendering fails, keep the escaped Mermaid source readable.
- Keep wide tables, code blocks, and diagrams inside horizontal scroll containers.
- Escape raw HTML. Allow only safe external-link protocols and workspace-relative project-file links.
- Render Mermaid with strict security settings and without HTML labels.

## Non-goals

- Raw HTML execution, remote images, and arbitrary Mermaid click handlers are not supported.
- This is a practical transcript subset, not a byte-for-byte CommonMark implementation.

## Related files

- `src/lib/markdown.ts`
- `src/lib/mermaid.ts`
- `src/components/MarkdownText.svelte`
- `src/lib/markdown.test.ts`

## Verification

- `npm test`
- `npm run check`
- `npm run build:web`

## Evidence

- Confirmed by code and tests in the files above.
