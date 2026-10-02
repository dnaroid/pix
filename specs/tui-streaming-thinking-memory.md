# TUI streaming-thinking memory growth

Status: fixed and regression-covered.

## Problem

During a long or high-frequency reasoning stream, the TUI process could grow to
multiple gigabytes of resident memory even when the persisted session itself was
small. In the incident that motivated this fix, the killed process had reached
roughly 10 GiB while the corresponding session JSONL was only about 85 KiB.
That ruled out retained persisted history as the primary explanation and pointed
to work performed repeatedly while the live assistant message was changing.

Two independent amplification paths were present in the streaming-thinking
pipeline.

### Hidden thinking was still fully rendered

The default thinking row can be collapsed with `previewLines: 0`. Despite the
body being invisible, each streaming update still passed the entire growing
thinking string through markdown table formatting, wrapping preparation, and
syntax-highlight scanning before the renderer discarded the body.

For a thinking stream of length `N`, repeatedly reprocessing prefixes of size
`1..N` turns a visually constant one-line row into roughly quadratic aggregate
allocation/work. The effect is amplified because active streaming entries are
updated frequently and cannot rely on a stable final render cache.

### Cumulative provider chunks could be appended as deltas

Most providers emit a true `thinking_delta`, but OpenAI-compatible endpoints are
not universally consistent. Some events can carry cumulative reasoning text in
the `delta` field while also exposing an authoritative partial assistant message.

Blindly appending such values produces this sequence:

```text
"a"
"a" + "ab"              -> "aab"
"aab" + "abc"           -> "aababc"
...
```

The in-memory thinking entry therefore grows much faster than the actual model
reasoning. The final provider message/session entry can still contain only the
correct reasoning snapshot, so post-mortem inspection of JSONL alone may not
show the size of the transient corruption.

## Fix

`renderThinkingEntry()` now determines whether the thinking body can actually be
visible before reading or formatting `entry.text`. A collapsed row with a hidden
body/zero preview renders only its header. Expanding the row, forcing all
thinking expanded, or configuring a visible preview still takes the normal body
rendering path.

`AppSessionEventController` now prefers the authoritative thinking content at
the event's `contentIndex` when it is available in `event.message` or the
assistant event's `partial` message. That snapshot is reconciled with the current
entry. Raw delta append remains the fallback for providers/events that do not
expose an authoritative partial block.

These changes are deliberately independent: avoiding hidden-body rendering
removes repeated full-prefix formatting allocations, while snapshot
reconciliation prevents malformed/cumulative provider events from inflating the
stored live entry itself.

## Invariants

- A collapsed thinking row with `previewLines: 0` must not read its body merely
  to render the header.
- Visible/expanded thinking must preserve the existing markdown and syntax
  rendering behavior.
- When an authoritative thinking snapshot exists for a content index, that
  snapshot wins over the event delta.
- A provider that emits only real deltas and no partial snapshot must continue
  to work through append fallback.
- Persisted session size is not a sufficient memory-leak diagnostic for live
  streaming; use RSS/heap telemetry as well.

## Regression coverage

`tests/conversation-tool-renderer.test.ts` uses a throwing getter for the
thinking body and verifies that rendering a collapsed zero-preview row never
reads it.

`tests/session-event-controller.test.ts` simulates cumulative reasoning chunks
(`"first"`, then `"first second"`) together with authoritative partial messages
and verifies that the resulting thinking entry is exactly `"first second"`, not
the concatenated value.

Focused controller/renderer tests plus `npm run build:pix` are the minimum
verification for changes to this path.

## Diagnostics

The TUI memory watchdog samples the process every 15 seconds. At the configured
RSS threshold it writes a report under `~/.config/pi/memory-reports/`; when safe,
the first report also includes a V8 heap snapshot. Periodic samples are logged to
`~/.config/pi/pix.log`.

When investigating a recurrence, compare:

1. process RSS and JS heap growth from the watchdog;
2. persisted JSONL size and entry count;
3. whether a long thinking stream was active;
4. provider/event shape, especially whether `thinking_delta.delta` is a true
   delta or a cumulative snapshot;
5. whether the thinking row was collapsed/hidden at the time.

If RSS rises while persisted history remains small, capture the watchdog report
before killing the process when possible. That preserves evidence which is not
recoverable from the final session JSONL.

For freezes or typing-time growth after the answer has finished, the internal
watchdog may be unable to run if the TUI event loop is blocked. The opt-in
[external memory/freeze profiler](tui-external-memory-profiler.md) can collect
RSS and macOS stack/map evidence independently. It is diagnostic instrumentation,
not evidence that the streaming-thinking issue explains every TUI recurrence.
