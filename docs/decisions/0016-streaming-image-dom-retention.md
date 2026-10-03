# 0016 — Retain Markdown image DOM during streaming

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: coding-agent implementation choice for the user's reported streaming image flicker; no independent user approval of implementation details.
- Governing spec: [Desktop Markdown rendering](../../specs/desktop-markdown-rendering.md), [transcript scrolling](../../specs/desktop-transcript-scrolling.md)
- Replaces / replaced by: none

## Context

Natural image dimensions alone did not resolve the user-reported appearance/disappearance of images while an assistant response streams. Preserve natural sizing, without fixed squares or a broad Markdown renderer rewrite.

## Observations and sources

- Reported observation: the user says the previous dimensions-only change did not help; images still appear/disappear during streaming.
- Verified code path: `desktop/src/components/MarkdownText.svelte` uses `{@html html}`, replacing markup on updates; `markdown-content-action.ts` lazily creates local/project media after observation and asynchronous resolution.
- Missing evidence: actual streaming Desktop reproduction has not yet established visual fix effectiveness.

## Decision

Restore unchanged local/project image preview subtrees in the content action's pre-paint microtask before observers/decorators. Match original parsed preview markup and occurrence order, preserving distinct duplicate nodes, pending resolution, decoded images and error state. Retain only previews present in the current render; clear ownership on destroy.

Image async work uses containment and destruction guards rather than render generation alone, because the same owned node can survive several generations. Video behavior keeps its generation guards. Remote images, diagrams and other HTML are not retained.

## Alternatives

- Dimension reservation alone: protects layout but recreates the image and repeats lazy hydration.
- Reconcile all Markdown DOM: substantially broader changes to code blocks, links, diagrams and interaction state; not needed for this scoped fix.
- Freeze streamed Markdown: suppresses legitimate text updates.

## Consequences

Expected to prevent repeated image hydration gaps while preserving existing dimensions and lazy first load. Retained nodes consume memory only while present; pending requests may finish but cannot attach to removed nodes. Exact-markup matching intentionally recreates changed captions/targets. Browser-level visibility verification remains required; detached/reinserted images are not claimed to guarantee continuity on every browser engine without evidence.

## Revisit when

Actual Desktop captures still show flicker, parsed preview markup changes between equivalent chunks, or broader renderer state needs preservation.
