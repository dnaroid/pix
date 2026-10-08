---
kind: spec
status: active
---

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
   Growing the multiline composer reduces the transcript viewport without disabling follow mode: layout-driven scroll events at an unchanged or forward offset must not cancel the pending follow frame. Actual upward scrolling still stops following, including during resize; readers already scrolled up retain their position and can scroll back to the new bottom.
   Stream updates and resize notifications share an already pending animation-frame scroll rather than canceling and postponing it; continuous streaming must not starve follow-latest scrolling.
   Each conversation remembers its latest reading offset and follow mode for the lifetime of the window. Selecting a different conversation saves the outgoing state and arms restoration before the shared pane's transcript is replaced. Returning to a scrolled-up conversation restores its latest saved offset, not its initial activation offset; returning to a following conversation restores its current bottom and continues following subsequent updates. A conversation not yet visited starts at the latest content. Hidden or pending-restoration geometry must not overwrite saved state, including rapid switches before a restoration frame. Layout-driven scroll events during that transition must not change the restored follow mode. Scroll frames and asynchronous explicit scroll completions owned by the previous conversation are cancelled or ignored. Reading offsets are not persisted across application restarts. See [per-conversation reading positions](../docs/decisions/0032-conversation-reading-position.md).
   Restoring the latest edge must account for estimated `content-visibility` heights: if moving the viewport materializes taller media entries, follow frames continue until the viewport reaches the current bottom. Stationary scroll events from those writes must not disable following before resize notifications arrive; actual upward scrolling still stops following. Explicit latest-content actions use the same settling behavior.
   This settling behavior is implemented and deterministically covered by scroll-controller tests; user-visible effectiveness in the native Desktop remains unconfirmed pending manual verification.
   Navigating to a specific transcript entry cancels any pending restoration frame, invalidates an explicit latest action still awaiting rendering, and leaves follow mode off. Switching to an auxiliary workbench tab (Preview, Git Diff, Terminal, or LSP installer) preserves the underlying conversation's follow mode. Hidden-pane scroll/resize events must not change that mode or write zero-sized scroll geometry. Returning restores the current bottom after layout when following, including content appended while hidden; a reader who had scrolled up instead retains their saved scroll offset without enabling follow mode.
3. Once the user scrolls away from the bottom, passive follow-latest scrolling stops until the user returns near the bottom. Explicit latest-content actions re-enable follow mode: using the jump-to-latest control or sending/appending a new user message scrolls the transcript all the way to the bottom after the new content is rendered.
   During an explicit send action's render wait, queued/layout scroll events from clearing the attachment composer and appending the message cannot disable follow mode. Image previews that decode or hydrate later continue following through content resize; manual scrolling after the render wait still stops following. Conversation switches, entry navigation, and disposal invalidate the pending explicit action.
   This includes sending a queued/deferred message with its frame's send-immediately button: append the message, restore the latest edge after rendering, then start its prompt request. If the active session or client changes while waiting for the previous run, do not append or scroll the newly active conversation.
4. A normal `pix/session/history` request returns a bounded recent persisted-history window plus an opaque cursor when older persisted entries exist.
5. When the Desktop viewport reaches the top threshold, it requests the preceding history page using that cursor and prepends the resulting transcript items.
6. Because collapsed/grouped tool rows can make many persisted entries occupy little vertical space, a loaded tail that still leaves the pane at the top triggers another cursor page after rendering; paging continues until the pane gains scrollable history or the cursor is exhausted.
   Pagination waits for pending scroll restoration, including a saved reader offset. A following transcript only auto-fills older history while its content fits the viewport. Its temporary zero offset after returning from the UI-only New Conversation chooser must not start pagination for an overflowing tail before the latest-edge restore frame. Prepend anchoring belongs only to a scrolled-up reader: a following viewport, or an explicit jump to latest while a page is pending, must not be pulled away from the live edge by an older anchor. Destroyed/replaced panes and changed sessions ignore late pagination corrections and retries.
7. Cursor pages start at a complete user turn when possible so the page boundary does not split an assistant/tool response away from its owning user prompt.
8. After prepend for a scrolled-up reader, Desktop preserves the current DOM transcript entry as the viewport anchor. Browser-native scroll anchoring is respected; an explicit offset correction is applied only for the remaining anchor delta. A following viewport stays owned by follow-latest scrolling instead.
9. Reaching the top repeatedly continues paging until the cursor is exhausted, at which point the first persisted transcript entry is reachable.
10. History pagination must not eagerly hydrate deferred tool bodies or start a Pi runtime merely to read older persisted JSONL history.
11. The floating jump-to-latest arrow has a fully transparent background, without a border, shadow, or backdrop blur, so transcript content underneath remains readable. Hover changes the arrow color, not its background; keyboard focus retains a visible outline.
12. Chat image attachments and project/local Markdown image previews retain natural proportions without cropping or upscaling, capped at their existing heights (20rem for chat attachments, 28rem for Markdown) and the available width. After the browser learns intrinsic dimensions, those dimensions reserve the frame through loading/error fallbacks and Markdown regeneration during streaming, including offscreen previews awaiting lazy hydration. A first image with unknown dimensions uses a compact fallback and can change height once on load; there is no arbitrary square or guaranteed reservation before dimensions are known. Composer/tool thumbnails, videos, and remote images in the Preview editor retain their existing sizing. Follow-latest behavior is unchanged.

## Implementation

Unchanged project/local Markdown image nodes are restored before lazy hydration
during streaming, not merely dimension-reserved. Pending work follows retained
node ownership; removed nodes and destroyed renderers ignore late completion.
See [image retention decision](../docs/decisions/0016-streaming-image-dom-retention.md).

- `desktop/src/app/transcript-scroll.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/app/prompt-queue-actions.svelte.ts`
- `desktop/src/app/desktop-prompt-action-services.ts`
- `desktop/src/app/session-history.svelte.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/transcript-history-pager.ts`
- `desktop/src/components/AttachmentGrid.svelte`
- `desktop/src/components/MarkdownText.svelte`
- `desktop/src/components/markdown-image-retention.ts`
- `desktop/src/components/markdown-content-action.ts`
- `desktop/src/lib/image-preview-layout.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `acp/src/acp/session-history-file.ts`
- `acp/src/acp/pix-acp-agent.ts`

## Tests

- `desktop/src/app/transcript-scroll.test.ts`
- `desktop/src/app/desktop-workbench-prop-builders.test.ts`
- `desktop/src/components/transcript-history-pager.test.ts`
- `desktop/src/app/prompt-queue-actions.test.ts`
- `desktop/src/app/session-history.test.ts`
- `desktop/src/components/markdown-image-layout.test.ts`
- `desktop/src/components/transcript-image-layout.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `acp/test/session-history-file.test.ts`
- `acp/test/agent.test.ts`

## Verification

- `npm --prefix desktop test -- transcript-scroll.test.ts`
- `npm --prefix desktop test -- transcript-history-pager.test.ts`
- `npm --prefix desktop test -- transcript-image-layout.test.ts`
- `npm --prefix desktop test -- prompt-queue-actions.test.ts`
- `npm --prefix desktop test -- session-history.test.ts acp-client.test.ts`
- `node --import tsx --test acp/test/session-history-file.test.ts` from the repo root
- `node --import tsx --test --test-name-pattern="desktop history cursor" acp/test/agent.test.ts` from the repo root
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- Manual desktop verification: open a conversation longer than the initial history tail, scroll continuously upward, and confirm older turns appear while the visible entry stays anchored and the first persisted entry is eventually reachable.
- Manual desktop verification: while remaining at the bottom, append/stream new transcript content and confirm follow-latest behavior still works.
- Manual desktop verification: grow a multiline composer while following the latest transcript, confirm the viewport remains at its new bottom; repeat while scrolled up and confirm reading position is not forced to the bottom, then scroll fully down again.
- Manual desktop verification: switch from a following conversation to an auxiliary tab while content continues to grow, return, and confirm the latest content is visible and follow mode continues. Repeat after scrolling up and confirm the saved position is restored without forcing a jump to the bottom.
- Manual desktop verification: scroll up in two restored conversation tabs, alternate between them, and confirm each retains its most recent reading position. Move to a new position and repeat, including rapid switches; neither tab should reset to the launch/initial activation position.
- Manual desktop verification: with older history still available, leave a long conversation at the latest edge, open the empty New Conversation chooser, return without sending a prompt, and confirm paging does not pull the restored viewport back into the transcript. Repeat while scrolled up and confirm reader anchoring still works.

## Evidence

- Confirmed by implementation: transcript follow-latest state and jump-to-latest behavior remain owned by `transcript-scroll.svelte.ts`.
- Confirmed by implementation/tests: when a latest-edge write materializes taller `content-visibility` content, the controller rearms a follow frame until it reaches the live bottom; stationary write-generated scroll events preserve follow mode, while actual upward movement cancels it. Native Desktop effectiveness remains unconfirmed pending manual verification.
- Confirmed by implementation: persisted history reads expose a backwards cursor and stay on the JSONL fast path, including when the Pi runtime is closed.
- Confirmed by implementation: `session-history.svelte.ts` stores the cursor per session and prepends older transcript pages without replacing the loaded tail.
- Confirmed by implementation: `TranscriptPane.svelte` loads an older page near the top and preserves a concrete transcript-entry DOM anchor after prepend.
- Confirmed by tests: persisted history cursor paging keeps turn boundaries intact, the ACP client forwards cursors, and the Desktop session-history store prepends older pages in order.
