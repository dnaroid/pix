# 0007 — Native spelling corrections in the macOS composer

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: user requested implementing the proposed native
  right-click correction flow in this task's conversation (no durable transcript link).
- Governing spec: [Desktop context menus](../desktop/workbench/desktop-context-menus.md)
- Replaces / replaced by: none

## Context

The user reported red-underlined spelling errors in the composer and requested
quick corrections on right-click. The existing generic menu suppresses WebKit's
default event and only includes editing roles, not spelling suggestions.

## Observations and sources

- [Context routing](../../desktop/src/lib/desktop-context-menu.ts) suppresses
  default context menus in the Tauri host.
- [Generic native menu](../../desktop/src/lib/native-context-menu.ts) builds
  Tauri editing items; it has no misspelled-word hit test or dictionary integration.
- System dictionary availability and the exact native suggestions are host-owned;
  mocked IPC/Chromium checks cannot establish native macOS acceptance.

## Decision

Allow the trusted pointer context event through to WebKit only for the enabled,
spellcheck-enabled normal prose composer on macOS. Keep custom menus elsewhere
and for synthetic keyboard context requests. Disable silent autocorrection and
spellcheck in code-editor mode. Preserve normal input handling and native undo.

This is a deliberate narrow exception to the blanket browser-menu suppression
policy: macOS owns the full spelling/text menu, including its other text services.

## Alternatives

- Build a custom dictionary/suggestion popup: duplicates native spelling, word
  hit-testing and editing/undo integration and is unnecessary for the requested flow.
- Allow default menus on all editable surfaces: unnecessarily changes code,
  passwords, terminals and other application contexts.

## Consequences

No extra dictionary dependency, asynchronous spellchecking or custom draft
replacement is needed. Suggestions depend on macOS language/dictionary settings;
native acceptance must verify correction, input persistence and undo. Keyboard
context requests retain editing commands but not spelling suggestions.

## Revisit when

Native acceptance shows that WebKit's menu cannot provide corrections reliably,
its additional text services conflict with product requirements, or spelling
suggestions are required for keyboard-only use or other prose fields.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"e2a32070d4c9a0afd6ae33e4e4572ba454f86ebf7daaea2485dc5dfe561f4631","checkedAt":"2026-10-30T23:46:59.615Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":55,"reportLanguage":"ru"} -->
