# Spec: Markdown soft-wrap highlighting

## Type

Change

## Goal

Keep syntax highlighting continuous when one logical Markdown or fenced-code line is soft-wrapped for terminal display.

## Scope

- Conversation Markdown rendered through `renderMarkdownTextLines`.
- Inline code, emphasis, links, headings, and syntax-highlighted fenced-code lines.
- Existing strong-emphasis marker removal and copy/wrap behavior remain unchanged.

## Non-goals

- Stateful parsing across explicit newline characters.
- Replacing the lightweight Markdown parser with a full CommonMark parser.
- Reconstructing inline syntax after Markdown table cells have already been reformatted into multiple logical rows.

## Behavior

- Highlighting is parsed against the complete logical line, then clipped and shifted onto every visual wrapped line.
- A soft wrap must not terminate or restart an inline Markdown construct, string, or comment.
- Visual lines retain their existing text, width, copy text, and continuation metadata.

## Related files

- `src/markdown-format.ts`
- `src/syntax-highlight.ts`
- `tests/markdown-format.test.ts`

## Verification

- Regression tests cover wrapped inline code, emphasis, links, headings, and fenced code strings/comments.
- Run `npm run check`.

## Risks / unknowns

- Explicit hard newlines remain independent syntax-highlighting units.
- Markdown table cell wrapping happens before display-line highlighting and remains a separate structured-rendering limitation.

## Evidence

- Confirmed by code: `renderMarkdownTextLines` wraps before `ScreenStyler` invokes line-local syntax highlighting.
- Confirmed by tests: existing tests cover Markdown styles and wrapping independently, but not style continuity across wraps.
- Confirmed by user report: inline-code color is lost after a terminal-width wrap.
