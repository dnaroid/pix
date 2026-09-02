# Spec: Mermaid diagrams in chat Markdown

## Type

Change

## Goal

Render supported Mermaid fenced code blocks as readable Unicode diagrams in chat messages.

## Scope

- Top-level Markdown fences whose info string identifies `mermaid`.
- User and assistant messages rendered through `renderMarkdownTextLines`.
- Complete fences and an in-progress fence that currently ends at the message boundary.
- Theme-aware diagram styling in the conversation renderer.

## Non-goals

- Browser, SVG, image, or interactive Mermaid rendering.
- Rendering nested or indented Mermaid constructs outside normal top-level fences.
- Replacing ordinary fenced-code rendering or supporting Mermaid syntax beyond the renderer dependency.
- Displaying parser warnings in the conversation.

## Behavior

- A supported Mermaid block is replaced by Unicode diagram rows when rendering succeeds.
- A diagram wider than the chat content is split into at most four numbered, slightly overlapping horizontal panels when each panel has enough room to remain readable. Every emitted row stays within the available content width.
- Before paginating a wide sequence diagram, participants and message labels are replaced by compact numbered markers in the art and preserved in wrapped legends below it.
- Diagram borders use the muted color, edges use the accent color, and labels retain the message foreground color.
- Fence markers are omitted when the diagram renders successfully; source fallback is shown as a styled ordinary code block without raw fence markers.
- Parser warnings are advisory: complete and streaming blocks both show the dependency's best-effort art when it is available.
- Mermaid HTML line-break tags are normalized to spaces before terminal rendering instead of appearing literally in labels.
- If parsing fails, the diagram type is unsupported, or the result would require too many/narrow panels, the original source remains visible as an ordinary code block.
- An unclosed final Mermaid fence is treated as streaming input and may render the dependency's best-effort result.
- Repeated frame renders reuse a bounded in-memory cache keyed by Mermaid source.

## Related files

- `src/markdown-format.ts`
- `src/app/rendering/conversation-entry-renderer.ts`
- `tests/markdown-format.test.ts`

## Verification

- Regression tests cover complete and streaming diagrams, wide-diagram pagination, extreme-width fallback, parse fallback, and ordinary fences.
- Run `npm run check`.

## Risks / unknowns

- Best-effort streaming output can change while a response is arriving.
- Horizontal panels preserve all diagram cells and overlap for context, but long connectors can still span vertically stacked views. Arrow markers in panel titles show which side continues.
- Diagram layout is controlled by `grok-mermaid`; unsupported grammar must continue to show as source rather than disappearing.

## Evidence

- Confirmed by code: all user and assistant chat Markdown passes through `renderMarkdownTextLines`.
- Confirmed by dependency API: `grok-mermaid` returns Unicode rows, semantic spans, and an explicit display width, or `null` when it cannot render.
