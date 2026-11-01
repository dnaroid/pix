---
kind: spec
status: active
---

# Desktop native process lifecycle

## Behavior

This contract applies to supported macOS Desktop. Retained Windows/Linux native
code is not a supported product or a compatibility requirement.

The native host reserves an ACP slot for an existing window before resolving or
spawning the backend. Repeated starts for the same window return the same live
generation; starts for different windows do not serialize on runtime resolution
or spawn. A start never returns a generation whose stdin a stop already closed:
it waits (bounded by the stop timeout plus forwarder drain) for that process to
exit and then spawns a fresh generation, or fails with a retryable
"still stopping" error. Destroying a window synchronously cancels its reservation and removes
the label from the registry; even a start already queued on the blocking pool
must not leave a child behind. Application exit rejects subsequent starts and
stops all owned children. Generation-checked stop cannot terminate a replacement.

ACP stdin is written by a worker, not an async command thread. `acp_send`
accepts a batch of 1..=256 newline-free JSON objects as one queue item. The
command boundary admits at most 16 queued batches / 8 MiB; a single oversized
batch is permitted exclusively. Saturated command admission returns an explicit
busy/retry error immediately; rejected writes are not accepted. Accepted batches
retain FIFO order, are written through a buffered writer, flushed once, and
settle their acknowledgements asynchronously. An invalid entry rejects only its
batch, with nothing written; an OS write failure rejects and drains all pending
writes. The webview keeps one batch in flight per run and coalesces later sends
into an ordered outbox (bounded to 4096 lines), so send order is strict.
Output producers backpressure on bounded queues rather than dropping lines.
Shutdown closes stdin and uses bounded grace before force-stop.
Output is emitted in bounded batches. ACP diagnostics remain separate from
protocol stdout.

On an unexpected ACP exit, the native exit event includes a separate 64 KiB
stderr tail captured before event batching. The supervisor waits at most 250 ms
for the stderr reader to finish, off the UI thread; a broken inherited pipe may
leave a partial tail but cannot indefinitely delay exit notification. Before
emitting `acp://exit`, the supervisor also waits at most 1 s for the stdout and
stderr forwarders to emit their final batches, so final JSON-RPC responses
arrive before exit rejects pending requests. The
Desktop error strip shows the exit status and a bounded diagnostic reason
(preferring a fatal line over stack frames), or explicitly states that stderr
is unavailable. Each connection attempt resets its frontend diagnostic buffer.

Unexpected exits and initialization failures save a bounded, uniquely named
receipt at `<workspace>/.pi/artifacts/acp-crash-<uuid>/stderr.log` via the native
blocking pool. Receipts contain the timestamp, failure summary and stderr tail;
common credential forms and terminal controls are stripped before saving/display.
Redaction is best-effort: logs can still contain private project data and should
be reviewed before sharing. The native writer caps receipts at 512 KiB, refuses
symlinked `.pi`/`artifacts` directories and creates files with mode 0600 on macOS.
The error strip reports the saved path or a saving failure without hiding the
original error. Requested stops do not create crash receipts; no workspace means
no project-local receipt. A reconnect/dispose invalidates pending log-save UI
updates, while an already submitted log may still finish saving for the original
project. These scratch receipts follow the normal artifact cleanup policy; they
are not a permanent crash archive.

The backend starts in its own process group on macOS. Cleanup signals
the process group before reaping an exited leader to prevent process-group ID
reuse, including natural exits. A force-stop
targets backend descendants;
normal stop first closes stdin for graceful nested-process disposal. Spawn and
stdio failure paths reap the child. A spawned PTY child is owned by a startup
guard until its supervisor takes ownership; all setup and registry rejection
paths kill and reap it. Native terminal startup reserves the same window lifetime
and serializes registry publication with window destruction; it rejects missing
or destroyed owners. Window destruction captures the exact terminal
operation IDs (including completed history) while cancelling the old lifetime;
delayed stop and pruning touch only those captured IDs, not resources published
by a replacement window using the same label. Workspace cleanup and application
exit still stop resources in their existing scopes. Application exit stops every
ACP slot and package terminal concurrently on a worker thread under one overall
6-second deadline (logging a warning for stragglers), so quit latency does not
grow with the number of windows.

Package terminal output is read by a dedicated PTY reader and coalesced into one
`package-terminal://output` event per ~16 ms or 64 KiB. The terminal supervisor
waits at most 1 s after the child is reaped for the reader's EOF and final
batch before it clears the running state and emits `package-terminal://exit`,
so trailing output (e.g. a crash trace) precedes exit and is not lost to an
immediate forget. A background descendant holding the PTY open only delays exit
by that bound. Retained replay history is a 512 KiB byte ring.

LSP onboarding package-manager commands are a separate transient class rather
than a long-lived per-window runtime. `install_lsp_server` runs its fixed,
user-approved command on Tauri's blocking pool and waits for that child to exit
before returning bounded output; it does not publish an ACP/PTY process
slot. Workspace/session invalidation therefore suppresses stale registration/UI
continuations but does not cancel a package-manager command that is already
running. See [desktop-lsp-onboarding.md](../operations/desktop-lsp-onboarding.md).

Source Control CI queries are another transient class, but unlike installer
commands they are explicitly cancellable. `gh`/`glab` commands run on the
blocking pool with stdin disabled, fixed argument vectors, bounded output,
isolated process ownership and a hard deadline. Each request is registered to
its owning WebView. Frontend workspace/HEAD invalidation requests cancellation;
native window destruction and application exit also synchronously remove and
cancel the matching registrations so a lost JS teardown cannot strand a child.
Native Code/Knowledge search and indexing requests follow the same ownership
model: each cancellation token records its owning WebView; window destruction
cancels that window's tokens, application exit cancels all of them and makes
later registrations start cancelled, and a request registered after its window
closed does not spawn the search child. The request is written to the child's
stdin on a separate thread, so cancellation and the deadline apply while a large
rerank payload is still being written.
After the CLI leader exits, descendant cleanup happens before pipe readers are
joined, preventing inherited output handles from keeping the command alive.

The Activity Bar's remote-Git freshness probe is a smaller transient class.
`workspace_git_remote_update_probe` runs `git ls-remote` on the blocking pool
only for the configured upstream ref, with stdin/prompts disabled. Each Git
subprocess, including the preceding local configuration/ref queries, has 64 KiB
bounds on each output stream and its own 5-second hard deadline; this is not a
5-second deadline for the entire multi-command probe. It uses the shared native
owned-child process-group isolation
but is not registered as a long-lived per-window process: frontend
workspace/generation guards discard stale completions, while the native
deadlines bound each orphaned subprocess. When the Git leader exits, descendants
are terminated before the leader is reaped and pipe readers are joined, so an
`ssh` or credential helper cannot keep the request alive. The probe never
fetches objects or mutates Git refs, the index, or the working tree.

## Constraints and failure cases

- A worker currently inside an OS pipe write cannot be interrupted by queue
  closure alone; forced process termination closes the pipe after grace.
- An individual ACP line may exceed the byte budget; the queue admits that
  line alone rather than corrupting the protocol.
- Forced cleanup uses SIGKILL on the isolated process group.
- Per-window slots are removed on destruction; cancelled reservations are not
  retained as tombstones for arbitrary labels.

## Regression coverage

- Oversized payload, saturated queue, shutdown

- Bounded capture, unique receipts, symlink refusal

- Late stderr, stale save success/failure, requested stops

- Summary, redaction and bounds

- Command-level admission, invalid JSON isolation, writer failure acknowledgement drain, startup/stop publication cancellation, same-label replacement resource isolation, natural exit with inherited pipe and PTY startup guards

- Destroyed reservation, isolated force-stop, bounded/read-only remote-Git update probe

- Windows job descendants after natural leader exit, injected suspended startup failure

## Verification

`cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib` and
`cargo check --manifest-path desktop/src-tauri/Cargo.toml` must succeed.
Optional retained-code check (not a Desktop delivery gate): on a non-Windows
host with the GNU Windows Rust target installed,
`cargo check --manifest-path desktop/src-tauri/native-job-crosscheck/Cargo.toml
--target x86_64-pc-windows-gnu --tests` typechecks the platform module and
its Windows-only tests without requiring a full Tauri cross-toolchain; this
does not execute the tests on Windows.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"a5fb367b16143f74bb91b3b84831d40bde60312c488989eced438983fe9ef5fd","checkedAt":"2026-10-31T00:52:06.803Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
