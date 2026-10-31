# Unified diagnostic logging

Pix's TUI/backend, ACP adapter, and Desktop write independent, best-effort diagnostic records to the shared `~/.config/pi/logs/` directory. There is no logging daemon: cleanup and writes are performed by running applications, so no process runs solely to maintain logs. The legacy `~/.config/pi/pix.log` is neither written by this system nor migrated or removed.

## Files and records

Each writer owns exclusive-create JSONL segment files named
`pix-v1-<creation-time-ms>-<source>-<writer-id>-<sequence>.jsonl` (fatal Node
records may include `-fatal-` before the sequence). Sources are `backend`,
`acp`, or `desktop`. Writers never rename, truncate, or rotate another
writer's segment. A segment is rotated before a write would exceed 10 MiB and
when its age reaches one hour. New files request mode 0600 and the log
directory mode 0700 (platform/filesystem permissions apply).

Each JSONL line is a version-1 object with `time` (UTC ISO timestamp), `level`,
`source`, `module`, `pid`, `project`, `event`, and `details`; `sessionId` and
cumulative `dropped` are present when available/nonzero. `project` is either
`null` or `{ "name": "…", "path": "<absolute path>" }`. Backend/ACP
context is associated with the operation; ACP resolves request session and
workspace context using async-local context. Desktop frontend reports snapshot
the current window workspace/session at report time, not necessarily the
operation that caused the error.

The default threshold is `info` (thus info/warn/error); set
`PIX_LOG_LEVEL=debug` for debug records. ACP also accepts legacy
`PIX_ACP_LOG` as its fallback level setting. ACP stdout remains reserved for
JSON-RPC and is not a diagnostics channel.

## Privacy, limits, and coverage

When changing TUI, ACP, Desktop or pi-tools-suite operations, send meaningful
handled errors and recoverable warnings to the existing diagnostic logger,
even when the UI also displays them. Choose appropriate levels, avoid duplicate
or noisy events and sensitive payloads, and never let logging change operation
behavior.

Chat/request payload fields are not intentionally logged. Structured fields
with sensitive/payload names are redacted, and URL/token/key-like strings are
best-effort redacted. Records, strings, nesting, and queues are bounded;
overload or write failures may drop records, reported cumulatively by `dropped`
on later records when possible. Redaction cannot guarantee that arbitrary
error strings contain no secrets; review logs before sharing them.

Logging is explicit rather than a capture of all process output. Backend
records include selected lifecycle/extension/watchdog events, handled TUI
operation errors, terminal model/compaction/retry failures, and tool-failure
warning metadata (not tool output). ACP records include handled handler errors
with request project/session context while preserving the original rejection;
cancellation is debug-level and invalid request/method/parameter rejections
record warning metadata only. Errors rejected by custom parameter parsing before
the handler are not covered. CLI install/update unexpected errors are logged
and pending writes flushed before return/rethrow. Desktop includes explicit
native errors and lifecycle/panic records, plus frontend reports and
uncaught/unhandled handlers. Third-party logs are not generally captured, and
this is not a guarantee that every error is captured.

ACP request failures are attributed to their actual registered RPC method,
not to the generic `session/cancel` notification. A pending elicitation
rejected after its session has been closed is treated as an expected teardown
event (debug), while an active-session elicitation failure remains a warning.
Desktop ignores the browser's no-exception `ResizeObserver loop` notices;
actual JavaScript exceptions and unhandled rejections still reach the logger.

### Additional operation diagnostics

- **TUI shell** emits `shell:started` (debug), `shell:settled` (info for
  success, warn for nonzero exit/signal, error for spawn failures), plus
  interruption, disposal, and rejected-operation diagnostics. Only exit
  status, signal, duration, and failure category are recorded: the shell
  command, stdin, stdout, and stderr are never included in these events.
- **TUI dictation** emits connection/listening/stopping/disposal transitions,
  socket/recorder failures and language-save failures. Events never contain
  audio, transcript text, configured API keys, WebSocket close reasons, or
  recorder stderr. A failure records its error class, not arbitrary input.
- **TUI resume listing** emits debug completion/empty-list metadata and
  warnings for skipped or unreadable session files. Aggregate counts and
  durations are logged without session messages or filenames; cancellation
  appears as an `aborted` flag in the debug completion record, not as a
  warning for unprocessed files.
- **ACP explicit indexing** emits `search:index-completed` (info) and
  `search:index-incomplete` (warn), scoped to the workspace, including Git
  Commits passes. Records contain only source, completion flag, counts (when
  available), elapsed time, and allowlisted phase/reason of an incomplete
  operation (when known); they exclude search queries, document text,
  embedding inputs/responses, provider error messages, and user-managed
  settings content. Cancelled operations do not emit a completion event.
- **Desktop webview lifecycle** reports a fixed native-allowlisted set of
  `acp:*` and `updater:*` status events via `log_desktop_event`. Normal
  ready/available states use info, in-progress/current checks use debug, and
  failures/unexpected ACP exit use warn. This command accepts no arbitrary
  diagnostic payload or custom event names; it shares the frontend's bounded
  IPC queue and workspace/session snapshot behavior. Existing error reports
  continue through `log_desktop_diagnostic`, which also only accepts a native
  allow-list of event names: `frontend:error`, `frontend:uncaught`,
  `frontend:unhandled-rejection`, `media:playback-unavailable` and
  `frontend:warning`. Handled, recoverable frontend failures use
  `logger.warn(label, error)` → `frontend:warning` (warn level), with a
  subsystem label such as `tray:publish`, `notification:permission`,
  `notification:delivery`, `sidebar:git-remote-probe` or
  `project-explorer:files-refresh` prefixed to the diagnostic. Recurring poll or
  retry failures use `createFailureStreakReporter` to log once per failure streak
  (the first failure after a success), not on every attempt. Subsystem
  failures call `warn(label, error)` directly; as a safety net,
  `report(error, event)` with an event outside the native allow-list is sent as
  `frontend:warning` with that event name as the label instead of being
  rejected and silently dropped.
- **Desktop native Git mutations** record fetch, pull, update, stash save/apply,
  and discard-file results at info (success) or warn (failure), scoped to the
  workspace. Git arguments, individual file paths, ref names, and command
  output are not logged.

These events describe operation boundaries rather than every UI redraw,
streamed token, search request, or shell output chunk; verbose transitions
remain behind `PIX_LOG_LEVEL=debug` to limit normal log volume.

### Search indexing

Indexer diagnostics from ACP and the suite use the shared Pix JSONL sink with
`module: "search.index"` and fixed `search:*` event names. Only terminal
failure/incomplete states, background-worker failures and aggregate skipped
transcript reasons are warnings; meaningful successful vector saves are debug.
Policy-selection changes and aborts are expected background cancellations,
not worker-failure warnings; genuine policy-read failures remain warnings.
Code/Knowledge native Desktop indexing reports its outcome through the same
native logger. No per-pass start, five-second heartbeat, empty success, prompt,
provider response, session ID, individual path, or raw exception text is
included. Counts, duration, fixed failure phase, safe error class and allowlisted
I/O/SQLite code are permitted; repeat causes are coalesced for five minutes.
Standalone Pi remains independent of Pix logging. The dedicated project-local
`.pi/artifacts/search-diagnostics-*/events.jsonl` writer and the Desktop
Indexer Activity history have been removed; existing old files are unrelated
to ongoing log collection.

### Bundled pi-tools-suite

When loaded by Pix TUI or its Desktop-owned RPC process, the suite emits
selected `suite:*` events through the same backend JSONL logger, with
`module: "suite.<area>"`. Coverage includes module-load failures, DCP
journal/progress/summarizer degradation, explicit search-index errors and
incomplete passes, unexpected search-query failures, subagent launch and
handled-action failures, TODO/project-task persistence and operation errors,
workspace grant failures, LSP broker startup, credential import/reload,
provider/auth degradation, and web-search provider fallback. Expected
cancellations, streamed output, successful tool calls and UI notifications
are **not** mirrored wholesale. Detailed DCP and subagent journals
retain their existing separate locations and limits; the old search-specific
`events.jsonl` writer is removed.

High-signal DCP records include `suite:auto-compression-failed` (safe blocked
reason and phase), `suite:manual-compression-failed` (preflight/resolve/
summary/commit phase), and `suite:provider-request-blocked` (error, for
exhausted capacity or a stale provider-ready projection). The adapter also
reports journal-load issues, unsupported journals, stalled progress, and
summarizer fallback. Economic auto-compression rejections awaiting new source
are not raised as recurring warnings; detailed analysis stays in the DCP
journal. For indexing, manual incomplete/error events identify the source and
elapsed time; automatic session/task indexing emits warnings on operational
failure without starting a retry loop. Cancellation does not emit a failure.

The suite's shared-log adapter is optional: standalone Pi/headless use does
not require or attempt to import Pix's runtime. In Pix-owned processes it
uses an in-process sink published by `installPixProcessLogging` (also when
the suite is installed as a separate copy). A lazy import is available for
source/bundled checkout use; neither resolution blocks the triggering operation.
The initial pending buffer is limited to 32 records; failed imports/writes
are best-effort and cannot turn a successful tool result into an error.
Warnings/errors of the same event/area/project/session (when available), with
source/action/cause/phase distinctions, are coalesced within 60 seconds, with a suppressed-repeat count
included at the next emission. A bounded 128-key history needs no timer.
Only curated scalar status/count/classification fields are passed, not
exception messages/stacks, prompts, credentials, command arguments or
search/provider content. Review diagnostic records before sharing them.

Desktop frontend IPC limits pending reports to 16; native writer queue capacity
is 256 and Node's queued bytes are bounded to 1 MiB. Native exit flush is
bounded; fatal monitor/panic paths synchronously attempt a segment write.
`SIGKILL` and abrupt power loss cannot be flushed.

## Desktop Logs sidebar

The optional `desktop.logPanelEnabled` setting defaults to `false` and is
available at **Settings → Desktop → General → Logs panel**. It takes effect
after a successful save in the current window; other windows reload the
preference on focus. When off, the Logs sidebar is hidden and its monitor stops; this does
not disable diagnostic log collection.

The native `read_diagnostic_logs` command reads only the fixed
`~/.config/pi/logs/` location. It accepts no path, performs blocking filesystem
work away from the UI thread, and is read-only. A snapshot is bounded to 4096 directory entries, 64 files, 1 MiB
total, 256 KiB per file, and 500 records; partial trailing/tail lines,
malformed records, and symlink files are skipped. The panel displays the
snapshot chronologically, newest last. It initially follows the bottom and
follows incoming updates only while the reader remains there; scrolling up
pauses following, and returning to the bottom resumes it. When rows change,
the panel preserves the reader's visible record anchor, including when older
rows are evicted from the bounded snapshot. It offers local text, level, source
and current-project filters, pause/resume, and manual refresh. Level/source
choices use the existing Pix `TaskFieldSelect`
popup/listbox, not native selects or system option menus. **Clear all logs**
requires confirmation (with a safe Cancel action and focus behavior) and deletes
recognized regular diagnostic segments from the shared directory, across all projects and sources,
regardless of the panel's filters or recent-snapshot limits. The native
`clear_diagnostic_logs` command accepts no path and runs off the UI thread;
symlinks, subdirectories, unrelated files, legacy `pix.log`, and memory reports
are not cleared. On the supported macOS host, deletion is anchored to an opened,
non-symlink directory, so replacing its path cannot redirect deletion elsewhere.
Missing/already removed files are harmless; partial failures are reported. This
does not turn logging off: concurrent or subsequent writes may appear again.
Polling stops and in-flight reads are invalidated during deletion; stale
responses cannot restore rows, and the completed clear discards the cached
snapshot even when paused. A completed clear with per-file failures reports
their count without restoring the discarded snapshot. If the command itself
rejects, the panel reports the error and retains its last snapshot. The native writer retries a record
once if clearing removed its current segment, preserving that next record.
It polls every two seconds only while mounted, visible and
unpaused; stale responses are ignored. Record timestamps are displayed as local
wall-clock `YYYY-MM-DD HH:mm:ss.SSS` using the host timezone (including the
date-specific daylight-saving offset); the datetime attribute, tooltip and
expanded JSON retain the original UTC timestamp. Warning-level labels use the
semantic tool-warning theme color, while error labels remain destructive. This
is a bounded recent snapshot, not
full searchable history. Review logs for sensitive information before sharing;
redaction is best effort.

## Shutdown and integration

Normal TUI shutdown also awaits pending log writes after runtime disposal;
the existing forced-exit grace deadline still applies, so a stalled filesystem
can lose the remaining queue at that deadline. Native append failures reset
the failed segment so subsequent records can recover without waiting an hour.

ACP imports the shared logger and privacy implementation from the root
`dist/` output. Build the root (`npm run build:pix`) before building or starting
ACP from a checkout. Release preparation builds root then ACP and includes
the complete root `dist/` directory in the bundled runtime.

Memory reports remain separate from the redacted JSONL stream and may contain
unsanitized runtime diagnostics. Newly created report directories/files request
0700/0600 permissions; inspect reports and heap snapshots before sharing.

## Retention

While an application is running, maintenance runs at most once per 60 seconds
and removes only regular files matching the known segment filename grammar
whose filename creation timestamp is at least 24 hours old. No cleanup occurs
while all applications are closed. Since expiration is based on segment
creation rather than each record's timestamp, records near the end of a
segment can expire up to one hour early.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"c5d69555d048fd0e0e550990c403f96106bc5a66c3bf1da1341459f984843b93","checkedAt":"2026-10-31T00:03:01.984Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":70,"reportLanguage":"ru"} -->
