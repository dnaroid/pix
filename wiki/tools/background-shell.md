---
kind: spec
status: active
---

# Background shell jobs

[Tools index](index.md) · [pi-tools-suite](suite.md) · [Original proposal](../proposals/agent-workflow-parity/background-shell.md)

The default-enabled `background-shell` suite module lets the agent start dev
servers, watch builds and long test runs, and keep working while they run.
Implementation: `external/pi-tools-suite/src/background-shell/` (`manager.ts`,
`service.ts`, `config.ts`, `index.ts`) and the alias layer in
`src/model-tools/index.ts`.

## Model tools

| Tool | Behavior |
|---|---|
| `Bash` (Claude profile), `bash`, `shell` (Codex profile) with `run_in_background: true` | Starts a job and returns after a 1.5 s startup window with the job id (`bg_…`), pid, log path and any early output. Optional `max_runtime` (seconds) terminates the job when it elapses. No runtime limit applies by default. |
| `shell_output(job_id?, since?, filter?, max_bytes?)` / alias `BashOutput(bash_id?, filter?)` | Returns output produced since the previous read. The server keeps a cursor per job. `since` re-reads from an absolute byte offset still in the ring buffer, and `filter` is a line regex. Default `max_bytes` is 32768. The result includes the status (`running`, `exited(code)`, `killed`, `failed`), the next cursor, a truncation flag and the log path. Without a job id it lists the session's jobs with id, status, pid, age and command (no cursor is consumed). |
| `shell_kill(job_id, signal?)` / alias `KillShell(shell_id)` | Signals the whole process group, `SIGTERM` by default, and escalates to `SIGKILL` after 3 s. Returns the final status. |

There is no separate `shell_jobs` tool; the Desktop icon mapping keeps the
`shell_jobs` name only so older transcripts still render.

The tool profile exposes `BashOutput`/`KillShell` for the Claude profile and
`shell_output`/`shell_kill` otherwise, and only when the module is loaded. If
the module is disabled, `run_in_background` fails with an explicit error. Stdin
is not connected and there is no `shell_input` tool.

## Execution, policy and output

- Jobs use the same tool names as synchronous shell calls, so the same
  `tool_call` hooks and policy apply. `shell` resolves `cwd`/`workdir` through
  the [shell workdir grants](../operations/shell-workdir-session-grants.md), and
  `credential-firewall` redacts results through its `tool_result` hook.
- The environment matches SDK bash: the Pi bin dir on `PATH` plus
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and
  `PI_REASONING_LEVEL`. Each job runs in a detached process group.
- Commands that bind all interfaces (`0.0.0.0`, `::`, `--host` without a
  loopback address) are allowed under existing policy. The model and the UI both
  get a visible network-exposure warning.
- Each job keeps a 256 KB in-memory ring buffer for the model. The full log is
  written to `.pi/artifacts/background-shell/<session>/<job>.log`, with a
  `<job>.json` metadata file (pid, process start time, owner pid/start) next to
  it. See [artifact storage](../operations/harness-artifact-storage.md).
- The registry is keyed by session, so ACP sessions sharing a process are
  isolated. `backgroundShell.maxJobsPerSession` (default 8, range 1–64) limits
  the number of running jobs per session. Win32 is unsupported and fails
  explicitly.

## Lifecycle

- `session_shutdown`, for any reason including fork, kills every job of that
  session. Late output is discarded. A fork does not inherit jobs.
- On process `exit` and on `SIGTERM`/`SIGINT`/`SIGHUP`, the host kills all job
  groups synchronously and then re-raises the signal when nothing else handles
  it.
- Cancelling a turn (Escape) does **not** kill jobs.
- On `session_start`, metadata from dead owner processes is checked against pid,
  process start time and command. Live orphans are reported (UI warning,
  Desktop popover, `/background-jobs orphans`) and are never killed silently.
  Stale metadata is removed.
- `/background-jobs list | kill <job_id> | kill-all | orphans | kill-orphans` is
  the user control surface. ACP runs it out-of-band, even while a prompt is
  active.

## Exit notifications

`backgroundShell.notifyOnExit` controls how job exits are reported:

| Value | Behavior |
|---|---|
| `context` (default) | If the agent is running and the turn continues with tool results, a `background-shell-exit` custom message (exit code and last lines) is added at that `turn_end`. An exit that misses a continuing turn (final turn, `agent_before_settle`, Escape) is shown as a UI notification when the run settles and reaches the model with the next user prompt (`before_agent_start`). Nothing is appended after the final assistant message, because a trailing non-assistant entry makes ACP report the session as `continuable` (shown as paused in Desktop). If the session is idle, the exit appears only as a UI notification. A turn is never triggered automatically. |
| `ui-only` | UI notification only. |
| `off` | No notification. |

Kills requested by `shell_kill` or `/background-jobs` produce no exit notice.
Configuration is layered: user `pi-tools-suite.jsonc`, then
`$PI_CONFIG_DIR/pi-tools-suite.jsonc`, then the nearest project
`.pi/pi-tools-suite.jsonc`. The environment variables
`PI_BACKGROUND_SHELL_NOTIFY_ON_EXIT` and `PI_BACKGROUND_SHELL_MAX_JOBS` override
all layers.

## Desktop and TUI

- TUI: `ctx.ui.setStatus("background-shell", "N jobs[ · M orphaned]")`.
- ACP/Desktop: the module publishes snapshots on the session-state channel
  `pi-tools-suite:background-shell:state`, throttled to 300 ms. Each snapshot
  holds `checkedAt`, `running`, jobs (with a 2 KB tail) and orphans. The
  Desktop store (`desktop/src/app/background-jobs.svelte.ts`) keeps one snapshot
  per session and ignores older `checkedAt` values. Snapshots are cleared when a
  session is forgotten or the connection resets.
- The status bar shows an icon indicator (`BackgroundJobsStatus.svelte`, Lucide
  `square-terminal`, styled like the subagent/todo indicators) when the session
  has jobs or orphans. It pulses in the success tone while jobs run, turns to the
  warning tone when orphans exist, and shows a small count badge for more than one
  live job. The accessible name and tooltip read `N background jobs[, M orphaned]`.
  Its popover shows each job as a native expandable details row: the summary
  keeps its command/description and status visible beside a Lucide chevron that
  rotates when expanded. Starting and running jobs default open; exited, killed
  and failed jobs default closed. Expanding a row reveals the bounded output tail,
  job actions and id. Native details/summary keyboard toggling is preserved.
  The popover also provides Kill for live jobs, Open log (Desktop preview),
  Stop all and Stop orphans.
  Controls send `/background-jobs …` to the ready runtime. Each command is
  deduplicated while pending, and errors from stale requests are dropped.

## Verification

- Suite: `test/background-shell.test.ts` (manager: cursor/exit/log, group kill
  with child, limit, shutdown and late output, kill during spawn, spawn failure,
  `max_runtime`, orphan detection, config layering) and
  `test/background-shell-tools.test.ts` (aliases, turn-boundary notice, idle
  UI-only notice, silent kill, workdir policy, network warning, shutdown).
- Desktop: `src/lib/background-jobs.test.ts`,
  `src/components/BackgroundJobsStatus.test.ts`.
- ACP: `agent.test.ts` covers `background-jobs controls run out-of-band while
  the parent run is active`.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"d8d02c1f8c994ddb65d6785f18044205985e550d794db1516fa08c77255c7381","checkedAt":"2026-10-30T23:09:51.401Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":63,"reportLanguage":"ru"} -->
