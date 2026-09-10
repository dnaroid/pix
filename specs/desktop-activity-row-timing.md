# Desktop activity row timing

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make collapsed Desktop activity rows identify what ran and how long completed activity took without adding polling or animation-driven timing work.

## Behavior

- A collapsed tool group shows unique presentation names in first-call order, separated by commas, instead of the generic `N tool call(s)` label. Repeated calls of the same normalized tool name appear once in the header; the individual calls remain intact when expanded.
- A completed tool group shows a muted elapsed duration next to the names.
- Tool-group duration is wall-clock span from the earliest recorded tool start to the latest recorded tool completion. Parallel calls therefore do not double-count elapsed time.
- A completed thinking row shows the same muted elapsed-duration treatment next to `thinking`.
- Thinking starts at the first live thought chunk and ends at the next visible assistant/tool/user activity boundary. If a prompt settles without another visible update, prompt settlement closes the trailing thinking interval.
- Duration capture piggybacks on existing Desktop session updates. There is no interval, polling loop, requestAnimationFrame timer, or per-row timer for elapsed time.
- Persisted history reuses timestamps already present in Pi JSONL instead of inventing a timer. The assistant message timestamp plus its enclosing session-entry timestamp reconstruct the persisted model-response span; the enclosing assistant entry marks the start of following tool execution, and each tool-result entry marks that tool's completion.
- A replayed assistant response with exactly one thinking block may show that persisted response span on the thinking row. When one assistant response contains multiple thinking blocks, replay omits per-thinking duration because the session format has no per-block timestamps and assigning the same duration to each block would be misleading.
- History without the required persisted timestamps still omits duration.
- Existing tool grouping, expansion, result loading, status icons, tool arguments, and thinking-body rendering remain unchanged.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/transcript.test.ts`
- `desktop/src/components/TranscriptPane.svelte`

## Verification

- ACP history tests cover preservation and propagation of persisted timing metadata. Transcript tests cover live thought boundaries, prompt-end finalization, replayed timing metadata, parallel tool wall-clock span, and duration formatting. Tool-presentation tests cover first-seen de-duplication of group header names.
- The full Desktop test suite passes.
- `npm run check` in `desktop/` passes with no Svelte or TypeScript diagnostics.
