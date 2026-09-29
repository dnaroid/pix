# Desktop activity row timing

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make collapsed Desktop activity rows compactly show the full thinking/tool flow and elapsed time both while activity is live and after it completes. Live "what is active now" status is delegated to a separate pinned status above the composer, outside the chat transcript.

## Behavior

- Consecutive thinking blocks and tool calls form one collapsible activity group. A visible user, assistant, or system message ends the group.
- A collapsed activity group header is a single-line native disclosure summary with exactly one chevron, the comma-separated list of distinct names in first-seen order (`thinking`, `read`, `shell`, …; SKILL.md reads label as `skill <name>`), and the elapsed duration. The names truncate; the header adds no aggregate status icon, no action or status text (`+N more`, `Completed`, `Failed`), no second row, and no failure inheritance — per-tool status and failure icons stay on the child rows inside the expanded group. Live-only activity status belongs to the pinned composer status above the input, not the chat header.
- The pinned composer status shows no spinner; a narrow highlight sweeps across the action text while the text stays in place. With reduced motion, it renders as static muted text.
- Historical/replayed thinking without enough timing metadata is not synthesized as active.
- The deterministic live-action heading derivation remains implemented and unit-tested in `activityGroupHeading` for the delegated pinned composer status: a fixed truthful label set derived only from normalized tool metadata, never inspecting command text or status payloads, so a shell running tests is not relabeled as tests and a subagent status call never claims spawning.
- Collapsed list names, including tools, skill reads, and `thinking`, use one muted neutral text color; separators and elapsed time are quieter still. No pulse or color-switching animation is attached to activity. A failed child tool call does not change the header; its failed icon stays on its own child row. Expanded rows keep their native tool-name colors.
- An activity group with a recorded start shows a muted elapsed duration on the header's single line, including while any entry is live. The live value advances from the earliest recorded start to the current pane clock; it freezes to the persisted final duration as soon as activity settles.
- Activity-group duration is the wall-clock span from the earliest recorded thinking/tool start to the latest recorded thinking/tool completion. Parallel calls therefore do not double-count elapsed time.
- Thinking starts at the first live thought chunk and ends at the next visible assistant/tool/user activity boundary. If a prompt settles without another visible update, prompt settlement closes the trailing thinking interval.
- Duration capture piggybacks on existing Desktop session updates. A single 100 ms pane-level interval samples elapsed time only while that pane has at least one active activity group. It is cleared when no activity remains active and on pane teardown; rows never own timers and inactive rows do not receive clock updates.
- Persisted history reuses timestamps already present in Pi JSONL instead of inventing a timer. The assistant message timestamp plus its enclosing session-entry timestamp reconstruct the persisted model-response span; the enclosing assistant entry marks the start of following tool execution, and each tool-result entry marks that tool's completion.
- A replayed assistant response with exactly one thinking block may show that persisted response span on the thinking row. When one assistant response contains multiple thinking blocks, replay omits per-thinking duration because the session format has no per-block timestamps and assigning the same duration to each block would be misleading.
- History without the required persisted timestamps still omits duration.
- Existing result loading, status icons, tool arguments, and thinking-body rendering remain available inside the combined activity group.
- Group construction is linear in the number of transcript entries: each contiguous activity run is collected and summarized once. Collapsed headings are derived from tool metadata without formatting raw inputs or patches.
- A collapsed group does not mount its child rows. Opening the group mounts compact headers only; thinking Markdown and tool bodies mount only while their own disclosure is open. Nested disclosure state survives closing/reopening the group and is scoped to the active session.
- The expanded group's vertical tool gutter is an accessible collapse button: clicking the line or its adjacent hit area, or activating it by keyboard, closes the group without clearing nested disclosures or triggering tool-result loads. Focus returns to the group header so keyboard users can reopen it.
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
- `desktop/src/components/ComposerActivity.svelte`
- `desktop/src/lib/composer-activity.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/lib/transcript-activity.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`
- `desktop/src/lib/composer-activity.test.ts`
- `desktop/scripts/transcript-activity-smoke.mjs`

## Verification

- ACP history tests cover preservation and propagation of persisted timing metadata. Transcript tests cover live thought boundaries, prompt-end finalization, replayed timing metadata, mixed thinking/tool grouping, the deterministic live-action headings retained in `activityGroupHeading` for the delegated composer status, first-seen name-list deduplication (including skill reads), controllable live-clock sampling/final-duration freezing, parallel wall-clock span, and duration formatting. Desktop visual regression tests cover the neutral collapsed header and natively-toned expanded rows; tool-presentation tests cover the expanded rows' tone mapping.
- `npm --prefix desktop test -- transcript.test.ts transcript-activity.test.ts session-history-concurrency.test.ts`
- `npm --prefix desktop run test:transcript-activity` exercises native disclosure events, lazy mounting/hydration, late completions, session replacement, the one-line collapsed header (chevron, neutral comma list, elapsed time — no status icons or action text) with failure kept on child rows, controllable live-duration updates/freezing and timer teardown, keyboard toggles, and a large collapsed transcript in Chromium with stubbed backend calls.
- `npm --prefix desktop run check` and `npm --prefix desktop run build:web` check types and production compilation. Browser smoke is not an end-to-end native Tauri or arbitrary-size frame-budget guarantee.
