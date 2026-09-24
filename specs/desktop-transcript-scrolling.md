# Desktop transcript scrolling

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep long Pix Desktop conversations scrollable from the latest content all the way to the first persisted transcript entry without eagerly materializing the whole session.

## Scope

- Keep the transcript as an independently scrollable workbench pane.
- Follow newly appended transcript content while the viewport is already near the latest message.
- Stop following the latest content after the user scrolls away from the bottom.
- Open persisted sessions from a bounded recent-history tail and page older history on demand.
- Preserve the visible transcript anchor when older history is prepended.
- Keep deferred tool outputs lazy; pagination and viewport anchoring operate on the compact/collapsed tool presentation rather than depending on expanded tool-body heights.

## Non-goals

- Changing message ordering, history replay, or deferred tool-result loading.
- Changing the jump-to-latest threshold or navigation behavior.
- Changing Preview pane scrolling behavior.

## Behavior

1. The transcript pane owns its vertical scrolling independently from the desktop shell and anchored composer.
2. When the transcript is following the latest content, appended content and transcript-size changes keep the viewport at the bottom.
3. Once the user scrolls away from the bottom, automatic follow-latest scrolling stops until the user returns near the bottom or explicitly jumps to the latest message.
4. A normal `pix/session/history` request returns a bounded recent persisted-history window plus an opaque cursor when older persisted entries exist.
5. When the Desktop viewport reaches the top threshold, it requests the preceding history page using that cursor and prepends the resulting transcript items.
6. Because collapsed/grouped tool rows can make many persisted entries occupy little vertical space, a loaded tail that still leaves the pane at the top triggers another cursor page after rendering; paging continues until the pane gains scrollable history or the cursor is exhausted.
7. Cursor pages start at a complete user turn when possible so the page boundary does not split an assistant/tool response away from its owning user prompt.
8. After prepend, Desktop preserves the current DOM transcript entry as the viewport anchor. Browser-native scroll anchoring is respected; an explicit offset correction is applied only for the remaining anchor delta.
9. Reaching the top repeatedly continues paging until the cursor is exhausted, at which point the first persisted transcript entry is reachable.
10. History pagination must not eagerly hydrate deferred tool bodies or start a Pi runtime merely to read older persisted JSONL history.
11. The floating jump-to-latest arrow uses a near-transparent panel background with a stronger hover surface so it remains legible without visually blocking transcript content underneath it.

## Related files

- `desktop/src/app/transcript-scroll.svelte.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/lib/acp-pix-extensions.ts`
- `acp/src/acp/session-history-file.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Verification

- `npm --prefix desktop test -- session-history.test.ts acp-client.test.ts`
- `node --import tsx --test acp/test/session-history-file.test.ts` from the repo root
- `node --import tsx --test --test-name-pattern="desktop history cursor" acp/test/agent.test.ts` from the repo root
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- Manual desktop verification: open a conversation longer than the initial history tail, scroll continuously upward, and confirm older turns appear while the visible entry stays anchored and the first persisted entry is eventually reachable.
- Manual desktop verification: while remaining at the bottom, append/stream new transcript content and confirm follow-latest behavior still works.

## Evidence

- Confirmed by implementation: transcript follow-latest state and jump-to-latest behavior remain owned by `transcript-scroll.svelte.ts`.
- Confirmed by implementation: persisted history reads expose a backwards cursor and stay on the JSONL fast path, including when the Pi runtime is closed.
- Confirmed by implementation: `session-history.svelte.ts` stores the cursor per session and prepends older transcript pages without replacing the loaded tail.
- Confirmed by implementation: `TranscriptPane.svelte` loads an older page near the top and preserves a concrete transcript-entry DOM anchor after prepend.
- Confirmed by tests: persisted history cursor paging keeps turn boundaries intact, the ACP client forwards cursors, and the Desktop session-history store prepends older pages in order.
