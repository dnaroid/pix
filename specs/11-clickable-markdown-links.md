# Spec: Clickable wrapped markdown links

## Type

Change

## Goal

Keep assistant and user markdown links clickable even when their destinations are longer than the terminal width, including browser-QA `file://` evidence links.

## Scope

- Inline markdown links whose destination starts with `file://`, `http://`, or `https://`.
- Markdown rendered in conversation messages.
- Mouse hit-testing for explicit rendered-link metadata, with existing visible-text detection retained as fallback.

## Non-goals

- Full CommonMark inline parsing.
- Changing editor/system-viewer selection.
- Supporting arbitrary URL schemes.

## Behavior

- Render a supported inline link as its label instead of its raw markdown destination.
- Preserve the destination and clickable label range through terminal wrapping and horizontal padding.
- Open the preserved destination when the label is clicked.
- Continue detecting plain file paths and plain web URLs from visible row text.
- Leave links inside inline code and unsupported URL schemes literal.

## Related files

- `src/markdown-format.ts`
- `src/app/rendering/conversation-entry-renderer.ts`
- `src/app/rendering/render-controller.ts`
- `src/app/screen/mouse-controller.ts`

## Verification

- Unit-test markdown parsing and wrapped range propagation.
- Unit-test conversation rendering with the long browser-QA evidence-link shape.
- Unit-test mouse opening from explicit rendered-link metadata.
- Run the focused tests, `npm run build:pix`, and `npm run check`.

## Risks / unknowns

- The implementation intentionally covers the safe schemes above rather than all CommonMark destinations.
- Existing plain-text link detection remains authoritative for non-markdown paths and URLs.

## Evidence

- Confirmed by code: markdown anchors were rendered literally and wrapped before per-row link detection.
- Confirmed by reproduction: the supplied long destinations split across 6–10 rows and produced zero detected links at widths 80, 120, and 180.
- Confirmed by environment: direct `zed --existing path:line:column` opening succeeds.
