# Desktop activity row timing

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make collapsed Desktop activity rows compactly show the full thinking/tool flow, identify what is active now, and show how long completed activity took without adding polling or animation-driven timing work.

## Behavior

- Consecutive thinking blocks and tool calls form one collapsible activity group. A visible user, assistant, or system message ends the group.
- A collapsed activity group shows unique presentation names in first-seen order, including the literal `thinking`, separated by commas. Repeated normalized names appear once in the header; every individual thinking block and tool call remains intact and in original order when expanded.
- A header name is emphasized with the semantic primary color while any occurrence of that activity is live. Tool calls are live while pending or in progress. Thinking is live only when its row has a recorded start and no recorded end.
- Historical/replayed thinking without enough timing metadata is not synthesized as active.
- A completed activity group shows a muted elapsed duration next to the names.
- Activity-group duration is the wall-clock span from the earliest recorded thinking/tool start to the latest recorded thinking/tool completion. Parallel calls therefore do not double-count elapsed time.
- Thinking starts at the first live thought chunk and ends at the next visible assistant/tool/user activity boundary. If a prompt settles without another visible update, prompt settlement closes the trailing thinking interval.
- Duration capture piggybacks on existing Desktop session updates. There is no interval, polling loop, requestAnimationFrame timer, or per-row timer for elapsed time.
- Persisted history reuses timestamps already present in Pi JSONL instead of inventing a timer. The assistant message timestamp plus its enclosing session-entry timestamp reconstruct the persisted model-response span; the enclosing assistant entry marks the start of following tool execution, and each tool-result entry marks that tool's completion.
- A replayed assistant response with exactly one thinking block may show that persisted response span on the thinking row. When one assistant response contains multiple thinking blocks, replay omits per-thinking duration because the session format has no per-block timestamps and assigning the same duration to each block would be misleading.
- History without the required persisted timestamps still omits duration.
- Existing result loading, status icons, tool arguments, and thinking-body rendering remain available inside the combined activity group.
- Group construction is linear in the number of transcript entries: each contiguous activity run is collected and summarized once. Collapsed names are derived from tool metadata without formatting raw inputs or patches.
- A collapsed group does not mount its child rows. Opening the group mounts compact headers only; thinking Markdown and tool bodies mount only while their own disclosure is open. Nested disclosure state survives closing/reopening the group and is scoped to the active session.
- Opening a group does not request all deferred results. Only opening an individual deferred tool result requests its body; the session-history controller deduplicates in-flight loads and does not re-request hydrated results.

## Related files

- `desktop/src/app/prompt-run-lifecycle.svelte.ts`
- `desktop/src/app/session-update-batcher.ts`
- `desktop/src/lib/transcript.ts`
- `desktop/src/lib/transcript-reducer.ts`
- `desktop/src/lib/transcript-timing.ts`
- `desktop/src/lib/transcript-presentation.ts`
- `desktop/src/lib/transcript.test.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/TranscriptActivityGroup.svelte`
- `desktop/src/lib/transcript-activity.test.ts`
- `desktop/scripts/transcript-activity-smoke.mjs`

## Verification

- ACP history tests cover preservation and propagation of persisted timing metadata. Transcript tests cover live thought boundaries, prompt-end finalization, replayed timing metadata, mixed thinking/tool grouping, active header labels, parallel wall-clock span, and duration formatting. Tool-presentation tests cover first-seen de-duplication of tool header names.
- `npm --prefix desktop test -- transcript.test.ts transcript-activity.test.ts session-history-concurrency.test.ts`
- `npm --prefix desktop run test:transcript-activity` exercises native disclosure events, lazy mounting/hydration, late completions, session replacement, live highlight transitions, keyboard toggles, and a large collapsed transcript in Chromium with stubbed backend calls.
- `npm --prefix desktop run check` and `npm --prefix desktop run build:web` check types and production compilation. Browser smoke is not an end-to-end native Tauri or arbitrary-size frame-budget guarantee.
