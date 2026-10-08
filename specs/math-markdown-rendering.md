---
kind: spec
status: active
---

# LaTeX math in Desktop and TUI Markdown

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Implemented in both Pix renderers.

## Goal

Render common AI-generated mathematical expressions as formulas instead of exposing raw LaTeX control sequences, without breaking code examples, streaming, or terminal-width safety.

## Scope

- Desktop transcript messages, Markdown Preview, and Markdown `read` results using the shared Desktop Markdown renderer.
- TUI user/assistant message text passed through `renderMarkdownTextLines`.
- Inline math with `$...$` or `\(...\)`, standalone display math with `$$...$$` or `\[...\]`. A complete `\[...\]` inside prose is treated as inline math.
- Unicode mathematical symbols, subscripts/superscripts, and fractions including non-English `\text{...}` content.

## Behavior

- Math recognition runs only outside Markdown inline-code and fenced-code contexts. Escaped dollar signs remain literal. Dollar signs with spaces immediately after opening or before closing do not form inline math (for example, currency amounts).
- Block math markers take precedence over ordinary paragraph parsing; within open math blocks, table and reference-definition recognition are disabled.
- Desktop renders LaTeX through KaTeX (bundled fonts/CSS) as inline or block MathML/HTML with accessible source semantics. A wide display expression scrolls horizontally inside its own bounded region without widening the conversation.
- Desktop KaTeX output is always generated with `trust: false` and throws on invalid input. Markup from the model is never inserted directly as HTML. The renderer escapes original source text when parsing fails or the expression is incomplete during streaming.
- TUI uses KaTeX-generated MathML, not HTML, as the source for Unicode terminal layout. Simple fractions are drawn across multiple rows with a fraction bar; operators, roots, and commonly supported scripts are converted to readable Unicode.
- When a formula's 2D drawing would exceed the available terminal width, the TUI uses linearized notation such as `(numerator)/(denominator)`, then wraps to the available columns. No generated formula row may overflow the message content width.
- Incomplete display math and invalid LaTeX remain visible as source inside a TUI code-style fallback. Inline failures also keep their original source rather than dropping content.
- Both renderers cap formula source length at 8,192 code units, cap KaTeX expansion, and keep bounded caches for repeated streaming/frame renders.

## Non-goals

- Pixel-identical typography between terminals and Desktop.
- Complete Unicode/MathML layout of all advanced TeX environments in the terminal; unsupported constructs use readable linear rendering where possible.
- Treating arbitrary non-Markdown tool output as mathematical text.

## Implementation

- `desktop/src/lib/markdown-math.ts`
- `desktop/src/lib/markdown-inline.ts`
- `desktop/src/lib/markdown-blocks.ts`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/styles.css`
- `src/terminal-math.ts`
- `src/markdown-format.ts`

## Tests

- `desktop/src/lib/markdown.test.ts`
- `tests/markdown-format.test.ts`

## Verification

- Test Cyrillic DER/JER fractions, inline formulas, narrow terminal wrapping, streaming incompletion, invalid TeX, escaped dollars, and code fences.
- Run focused renderer tests, Desktop production web build, TUI build and root check.
