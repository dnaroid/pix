# Spec: Fenced code blocks in chat Markdown

## Type

Change

## Goal

Show fenced code as a visually distinct code block without exposing Markdown fence markers in chat messages.

## Scope

- User and assistant messages rendered through `renderMarkdownTextLines`.
- Backtick and tilde fences, with known, unknown, or absent language info strings.
- Complete and in-progress fenced blocks.
- Mermaid source fallback when a diagram cannot be rendered.

## Non-goals

- Changing fenced blocks inside tool or thinking renderers.
- Adding syntax grammars for unsupported language names such as `text`.
- Changing inline-code rendering.
- Changing the copied code content by adding decoration or language labels.

## Behavior

- Opening and closing fence marker lines are omitted from rendered chat output.
- Code body lines retain syntax highlighting when the language is supported.
- Plain and unsupported-language blocks remain literal and do not apply Markdown emphasis.
- Every code body line uses a theme-aware contrasting foreground and background.
- Empty and just-opened streaming blocks retain one visually styled blank line.
- Source fallback for an unsupported Mermaid block remains visible as an ordinary code block, without raw fence markers.

## Related files

- `src/markdown-format.ts`
- `src/app/rendering/conversation-entry-renderer.ts`
- `tests/markdown-format.test.ts`
- `tests/conversation-entry-renderer.test.ts`

## Verification

- Regression tests cover complete, empty, unsupported-language, tilde, and streaming fences.
- Conversation tests cover user and assistant code-block colors.
- Run `npm run check`.

## Risks / unknowns

- Terminal applications cannot select a different font family, so visual separation uses theme colors.
- Fence markers intentionally remain part of the stored source even though they are absent from rendered/copy-selected output.
