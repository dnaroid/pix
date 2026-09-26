---
kind: spec
status: active
---

# Desktop native process lifecycle

## Behavior

The native host reserves an ACP slot for an existing window before resolving or
spawning the backend. Repeated starts for the same window return the same live
generation; starts for different windows do not serialize on runtime resolution
or spawn. Destroying a window synchronously cancels its reservation and removes
the label from the registry; even a start already queued on the blocking pool
must not leave a child behind. Application exit rejects subsequent starts and
stops all owned children. Generation-checked stop cannot terminate a replacement.

ACP stdin is written by a worker, not an async command thread. Its command
boundary admits at most 16 queued messages / 8 MiB; a single oversized JSON-RPC
message is permitted exclusively. Saturated command admission returns an explicit
busy/retry error immediately; rejected writes are not accepted. Accepted writes
retain FIFO order and settle their acknowledgements asynchronously. Invalid JSON
rejects only that write; an OS write failure rejects and drains all pending writes.
Output producers backpressure on bounded queues rather than dropping lines.
Shutdown closes stdin and uses bounded grace before force-stop.
Output is emitted in bounded batches. ACP diagnostics remain separate from
protocol stdout.

The backend starts in its own process group on Unix. On Unix, cleanup signals
the process group before reaping an exited leader to prevent process-group ID
reuse, including natural exits. On Windows, the backend starts suspended, is
assigned to a kill-on-close Job Object before its initial thread resumes, and
the job remains owned through leader exit. Natural exit and force-stop terminate
job descendants even if the leader has already exited. A force-stop
targets backend descendants;
normal stop first closes stdin for graceful nested-process disposal. Spawn and
stdio failure paths reap the child. A spawned PTY child is owned by a startup
guard until its supervisor takes ownership; all setup and registry rejection
paths kill and reap it. Native terminal startup reserves the same window lifetime
and serializes registry publication with window destruction; it rejects missing
or destroyed owners. IDX maintenance startup reserves that lifetime before
workspace/launcher preparation or spawn, then publishes only while the original
slot still owns the label and the window is available and not exiting. Its
slots-to-operations publication lock excludes synchronous destruction capture;
pipe failures, conflicts, and rejected publication kill and reap the guarded
child outside registry locks. Window destruction captures the exact terminal
and IDX
operation IDs (including completed history) while cancelling the old lifetime;
delayed stop and pruning touch only those captured IDs, not resources published
by a replacement window using the same label. Workspace cleanup and application
exit still stop resources in their existing scopes.

LSP onboarding package-manager commands are a separate transient class rather
than a long-lived per-window runtime. `install_lsp_server` runs its fixed,
user-approved command on Tauri's blocking pool and waits for that child to exit
before returning bounded output; it does not publish an ACP/PTY/IDX process
slot. Workspace/session invalidation therefore suppresses stale registration/UI
continuations but does not cancel a package-manager command that is already
running. See [desktop-lsp-onboarding.md](./desktop-lsp-onboarding.md).

Source Control CI queries are another transient class, but unlike installer
commands they are explicitly cancellable. `gh`/`glab` commands run on the
blocking pool with stdin disabled, fixed argument vectors, bounded output,
isolated process ownership and a hard deadline. Each request is registered to
its owning WebView. Frontend workspace/HEAD invalidation requests cancellation;
native window destruction and application exit also synchronously remove and
cancel the matching registrations so a lost JS teardown cannot strand a child.
After the CLI leader exits, descendant cleanup happens before pipe readers are
joined, preventing inherited output handles from keeping the command alive.

## Constraints and failure cases

- A worker currently inside an OS pipe write cannot be interrupted by queue
  closure alone; forced process termination closes the pipe after grace.
- An individual ACP line may exceed the byte budget; the queue admits that
  line alone rather than corrupting the protocol.
- On Windows, job creation, attachment, and initial-thread resume must succeed
  before startup returns; failures kill/reap the suspended direct child and close
  the job. Job assignment may fail if the OS forbids breakaway from an enclosing
  restrictive job; startup fails closed instead of running an unowned process.
  Unix uses SIGKILL on the isolated group.
- Per-window slots are removed on destruction; cancelled reservations are not
  retained as tombstones for arbitrary labels.

## Implementation

- `desktop/src-tauri/src/lib.rs::start_process`
- `desktop/src-tauri/src/lib.rs::stop_process_slot`
- `desktop/src-tauri/src/lib.rs::spawn_package_terminal`
- `desktop/src-tauri/src/lib.rs::start_idx_operation`
- `desktop/src-tauri/src/lib.rs::publish_idx_operation`
- `desktop/src-tauri/src/lib.rs::capture_destroyed_window`
- `desktop/src-tauri/src/lsp_install.rs::install_lsp_server`
- `desktop/src-tauri/src/git_ci.rs` (`GitCiProcessState`, bounded CLI runner)
- `desktop/src-tauri/src/acp_queue.rs::Queue`
- `desktop/src-tauri/src/native_process.rs::force_stop`
- `desktop/src-tauri/src/native_process/windows.rs` (suspended spawn, job ownership)

## Tests

- `desktop/src-tauri/src/acp_queue.rs` (oversized payload, saturated queue, shutdown)
- `desktop/src-tauri/src/native_lifecycle_tests.rs` (command-level admission,
  invalid JSON isolation, writer failure acknowledgement drain, startup/stop
  publication cancellation, same-label replacement resource isolation,
  natural exit with inherited pipe, PTY and IDX startup guards,
  pending IDX destruction/replacement publication)
- `desktop/src-tauri/src/lib.rs` (destroyed reservation, isolated force-stop)
- `desktop/src-tauri/src/native_process/windows.rs` (Windows job descendants
  after natural leader exit, injected suspended startup failure)

## Verification

`cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib` and
`cargo check --manifest-path desktop/src-tauri/Cargo.toml` must succeed.
On a non-Windows host with the GNU Windows Rust target installed,
`cargo check --manifest-path desktop/src-tauri/native-job-crosscheck/Cargo.toml
--target x86_64-pc-windows-gnu --tests` typechecks the platform module and
its Windows-only tests without requiring a full Tauri cross-toolchain; this
does not execute the tests on Windows.
