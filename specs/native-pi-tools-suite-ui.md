# Native Pi TUI presentation for pi-tools-suite

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

`pi-tools-suite` provides native presentation when it runs in the ordinary Pi
terminal UI without making Pix consume that presentation layer. Tool/state
semantics remain extension-owned; clean Pi uses Pi's public extension UI API,
while Pix TUI and Pix Desktop keep their existing renderer/bridge ownership.

## Host boundary

- Native suite presentation is enabled only when the extension context is
  `mode === "tui"`, dialog UI is available, and the process is not Pix-owned.
- Pix marks its in-process runtimes with the process-local
  `Symbol.for("pix.host.runtime")` before extension loading. Both the normal
  Pix runtime and sessionless draft-model runtime establish that marker.
- Pix Desktop/RPC child processes are also recognized by the existing
  `PIX_ACP_SESSION_STATE_BRIDGE`, `PIX_QUESTION_RPC_BRIDGE`, and Desktop
  profile environment boundaries.
- The guard is shared by every native suite widget. A Pix-owned host must not
  call `ctx.ui.setWidget()` from todo, async-subagents, or DCP.
- The suite `question` module is additionally marked clean-Pi-only in the
  module loader and has its own Pix-host guard. Pix continues to register its
  bundled `src/bundled-extensions/question` implementation and Desktop bridge;
  it must never receive a duplicate suite `question` registration.
- Headless/print/JSON/RPC operation keeps tool behavior without terminal
  widgets. Native presentation never becomes a prerequisite for tool execution.

## Todo widget

- Todo presentation reads the canonical live `TaskState`; it does not parse
  conversation text or reconstruct a second plan model.
- The widget is shown above the editor only while visible `pending` or
  `in_progress` tasks exist.
- It summarizes active/pending/blocked counts and shows a bounded set of active
  tasks with ID, current active form, and blockers. Completed/deferred/deleted
  work remains available through the existing tool and `/todos` views instead
  of occupying persistent terminal space.
- Tool commits, replay/startup, compaction/tree changes, internal auto-clear
  mutations, and shutdown refresh or clear the widget from the same canonical
  state.
- Each update prepares an immutable presentation snapshot: aggregate counts,
  at most five task rows, and an overflow count. `render()` reads only that
  bounded snapshot, so it is `O(MAX_VISIBLE)` and never scans or allocates from
  the live task state.

## Subagent widget

- Subagent presentation reuses the existing structured live-state payload
  produced by `async-subagents`; rendering must not add filesystem polling or
  parse human-formatted status output.
- The widget is shown above the editor while queued/planned, retrying, or
  running agents exist, with bounded task/activity rows.
- When the live count reaches zero or the session shuts down the widget is
  removed. Completed results remain conversation/tool history rather than
  persistent chrome.
- Each update prepares the same immutable bounded snapshot (aggregate counts,
  at most five rows, and overflow count). `render()` is `O(MAX_VISIBLE)` and
  never re-traverses live subagent runs or task previews.

## DCP context-capacity widget

- DCP uses a compact capacity map below the editor. The default full-width map
  has 40 cells and reduces its cell count for narrower terminals.
- Free versus occupied capacity comes only from live
  `ctx.getContextUsage().tokens / contextWindow`. If live token capacity is
  unknown or invalid, the map is unknown; DCP estimates must never manufacture
  free space.
- The cached prepared DCP projection may classify occupied volume as retained,
  candidate, protected incomplete-tool-group content, and current compressed
  summaries. Candidate remains advisory; compressed means current summary size,
  not removed source size.
- Classification follows the Desktop capacity-map semantics: estimates larger
  than live occupancy are scaled proportionally; estimates smaller than live
  occupancy place the unclassified remainder in retained/other occupied.
- The row also shows the live occupancy percentage, token/window values, and
  DCP's live approximate `tokensSaved` metric when nonzero. That saved value is
  not measured commit gain or billing.
- The widget consumes the existing DCP context-map telemetry produced during
  normal context preparation. Display refreshes do not run candidate detection,
  scan full history, prune context, or invoke a model.

## Question UI

- Clean Pi registers the same structured question contract used by Pix's bundled
  question implementation, including multiple questions, multi-select bounds,
  custom text, and image-bearing custom answers where the host supports them.
- In clean Pi TUI the interactive questionnaire is a transient
  `aboveEditor` widget, not a replacement for Pi's editor container. The real
  composer stays mounted and visible immediately below it.
- While the questionnaire is active, a native terminal-input listener routes
  keyboard input to the questionnaire and consumes it before the composer.
  Ctrl+C remains owned by Pi's normal interrupt path.
- The suite keeps the above-editor order `todo -> subagents -> question`.
  Todo/subagent refreshes re-assert the active question as the final
  above-editor widget, so background-agent progress cannot slip between the
  questionnaire and composer.
- Question completion/cancellation removes the transient widget and input
  listener, leaving the persistent widgets and composer intact.
- Clean-Pi questionnaire rendering uses only theme tokens supported by Pi's
  native `Theme` API; Pix-only aliases such as `headerBg`, `selectedText`,
  or `info` must not be passed to native `fg()`/`bg()`.
- In non-TUI execution it returns the existing UI-unavailable cancellation
  envelope/fallback prompt rather than blocking on terminal input.
- Pix does not load this module; Pix's bundled question implementation remains
  authoritative for its TUI and Desktop/RPC behavior.

## UI ownership

- Persistent suite presentation uses keyed `setWidget()` entries, with todo
  and subagents above the editor and DCP below it. The transient question widget
  shares the above-editor area but has explicit near-editor ordering priority.
- The suite does not replace Pi's footer with `setFooter()`. Existing
  short-lived dialogs, notifications, statuses, and tool renderers in other
  modules keep their current ownership.
- Adding a new persistent native widget requires an explicit clean-Pi use case
  and the same Pix-host guard; merely having a tool is not sufficient.

## Related files

- `external/pi-tools-suite/src/lib/native-pi-tui.ts`
- `external/pi-tools-suite/src/todo/native-tui.ts`
- `external/pi-tools-suite/src/async-subagents/native-tui.ts`
- `external/pi-tools-suite/src/dcp/native-tui.ts`
- `external/pi-tools-suite/src/question/`
- `external/pi-tools-suite/src/index.ts`
- `src/app/runtime.ts`
- `specs/desktop-runtime-status.md`
- `specs/desktop-question-tool.md`
- `specs/dcp-statistics.md`

## Verification

- `external/pi-tools-suite/test/native-pi-tui.test.ts` pins clean-Pi detection,
  Pix exclusion, widget placement/rendering, DCP no-fake-free-space semantics,
  and clean-Pi-only question registration.
- Existing todo, async-subagent, DCP context-map, config, and context-inventory
  suites cover state/lifecycle regressions around the new presentation hooks.
- Root runtime and bundled-question tests verify Pix still owns its question
  extension and can load renderer-owned extensions without duplicate
  registration.
- Both suite and root TypeScript checks are required.
