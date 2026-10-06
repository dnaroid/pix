---
kind: spec
status: active
---

# Project-shared LSP runtime and Desktop/TUI monitoring

## Behavior

LSP remains lazy: successful matching file mutations can start a configured
server and append diagnostics. Opening a panel or requesting status does not
start servers, prompt for trust, create a session, or send an LLM/user message.

Desktop's LSP sidebar uses the active conversation as a connection to the shared
project runtime. Independent connected Desktop tabs and TUI Pi processes in the same
project reuse one manager and one server per configured server ID/root, rather
than one server per conversation. TUI `/lsp`
opens a focused keyboard monitor: arrows browse processes, `u` refreshes, and
Escape or Ctrl+C dismisses. Neither panel offers Start, Stop, Restart or Trust.
Dismissing either panel leaves servers running. Panels
refresh every four seconds while mounted and show state, root, PID when known,
warnings and errors. Requests are serialized within a panel; disposed panels
ignore late completions and release polling resources.

Rows represent actual runtime processes in `starting`, `running` or `stopping`
state, including idle running processes ready for reuse. Configuration/root
matches alone never create rows. Failed attempts with no reusable process are
reported as warnings, not available-server rows. Each process is retired after
15 minutes without Pix editing or an LSP request, measured from completion of
its last operation. Overlapping requests and shared startup hold activity guards:
in-flight work cannot expire. Activity from any attached owner resets the same
process's timer. Status polling and cached diagnostic reads do not reset it.
Cleanup uses one resettable, unreferenced timer per idle process in the manager,
not UI polling or CPU/process sampling, and works without an open panel.
An idle-retired process disappears from monitoring; the next edit or LSP request
lazily creates it again. Replacement waits for the retiring process's teardown
before spawning another. Replacing or closing one session releases
only its attachment while another remains connected. Last departure tears down
the runtime. Existing file-based LSP tools retain their lazy acquisition path;
monitoring does not acquire a language server.

Reuse is generic for every configured server ID, including future additions:
physical workspace roots (and file/cwd aliases) are canonicalized before local
manager identity checks as well as IPC. Concurrent acquisition shares startup;
retry of a failed client waits for its teardown and rechecks owner/cancellation
fences. Different language-server IDs and legitimate separate package workspace
roots remain independent, rather than being collapsed into one process globally.

Repeated SDK extension binding (`session_start`) for an unchanged sessionManager
and project retains its lease; it must not briefly detach the sole owner and
kill reusable processes. A genuinely replaced session still fences old work.

The private ACP endpoint and `/lsp-control` retain their transport names for
compatibility but accept only `status`; former start/stop/restart/trust requests
are rejected. Internal manager/broker control helpers remain for lifecycle
regressions and are not exposed by either panel or command.

The existing [configuration trust contract](lsp-trust.md) is unchanged. Status
uses noninteractive config loading. Trust prompts belong to the existing file
execution/edit path, not monitoring. Snapshots carry `trustRequired` independently
of advisory/config-load warnings. The Desktop trust instruction appears only
when that flag is true; monitoring can still display already-owned processes
without granting the caller execution permission.

LSP processes are owned by a local project broker, not an external IDE daemon
or whichever tab happened to start them. Session startup attaches to this
lightweight broker without launching any language server. A live IPC connection
is the ownership lease: ordinary disconnect and client process death release
it. Closing the original spawning tab must not kill a server another attached
tab still uses. The last attachment's departure fences startup, shuts down
owned servers and terminates the broker. On POSIX each server retains its
supervisor: broker-input EOF, server exit and supervisor failure sweep that
server/wrapper group, including stubborn descendants. Desktop's existing
close/quit consent remains: cancelling the close must not release the runtime's
attachment. No native lifecycle changes or extra LSP confirmation are introduced.

Rationale: [0056 — Monitoring-only LSP panels](../docs/decisions/0056-lsp-monitoring.md)
and [0057 — Canonical LSP reuse and bounded idle retention](../docs/decisions/0057-lsp-reuse-idle-cleanup.md).
These decisions supersede the controls/idle policy in [0052](../docs/decisions/0052-owned-lsp-control.md)
and [0054](../docs/decisions/0054-project-shared-lsp.md). Project ownership from
0054 remains in force.

## Constraints and failure cases

- No blanket eager startup or manual panel startup. Global configuration may
  include languages absent from this project; status does not resolve candidate
  roots into rows or missing-language warnings. Live processes remain visible
  even if their config or root markers disappear.
- Only Pix-owned, non-daemonizing children are controlled. A server intentionally
  escaping its process group is outside the ownership guarantee. External IDE
  servers are never discovered or killed.
- Project identity is the canonical real path of the nearest ancestor containing
  `.pi/pi-tools-suite.jsonc`, otherwise the nearest `.git` ancestor, otherwise
  runtime cwd. Discovering that path is not a trust decision. Different project
  identities must not share processes; symlink aliases of the same
  project must share them. Shared control cwd/roots and diagnostics file paths
  are canonicalized so aliases cannot create a second physical-root server or
  bypass same-document serialization. Trusted root markers may resolve above
  the broker project directory; live nested/ancestor roots remain observable.
- Broker endpoints are private to the OS user, not project-writable executables.
  Concurrent first attachments must not create duplicate managers. Dead endpoints
  must recover safely without unlinking a live broker. Connection/RPC failures
  are bounded errors; a disconnected client may reconnect to a fresh broker.
  The PID/inode ownership lock remains through graceful teardown and process
  exit. Recovery removes a dead owner's lock only after its PID is gone; a
  replacement must not overlap the retiring broker's socket cleanup.
- Configuration/trust is evaluated in the requesting Pi process. Only its
  approved configuration snapshot crosses IPC; the broker does not own SDK UI
  contexts, run trust dialogs or grant trust to other sessions. A Trust once
  decision in one Pi process is not a Trust once decision in another. Status
  may display already-owned processes even when the caller cannot start them.
- A running server retains the configuration used to create it until later
  recreation. The broker inherits its spawner's base environment;
  approved server `env` values overlay that environment. Per-session differences
  in global configs or base environments do not create another server with the
  same ID/root, and another client's running server is not evidence of trust.
- The bundled Markdown configuration example uses `.git` as its root marker.
  Nested `README.md` and `package.json` files must not split a Git project's
  Markdown workspace into separate processes. TypeScript/Svelte keep their
  language-specific root markers. Non-Git workspaces require an appropriate
  explicit root marker or no markers (runtime cwd fallback).
- POSIX guardian startup uses the current Node executable (Node from PATH for
  Bun development); its PID metadata is separate from its ownership stdin pipe.
  Panel PID is the actual server/wrapper PID, not the supervisor PID.
- Shared project IPC applies to POSIX TUI and macOS Desktop. Windows TUI retains
  its existing session-local manager and taskkill cleanup rather than failing
  on Unix IPC; its panel labels that narrower scope. Shared project ownership
  on Windows is not supplied by this change. The supervisor hard-kill guarantee
  and independent-process regression evidence apply to POSIX. Desktop is
  supported on macOS only; TUI platform support is not removed.
- Desktop polls only an existing connected active session. Status is allowed
  while an agent turn is busy; monitoring exposes no runtime mutations.
- ACP's private `pix/session/lsp` maps to a correlated hidden Pi prompt handled
  as an extension command, not an agent turn. Snapshots use the session event
  stream before command acknowledgement; direct stdout writes are forbidden
  because the SDK's RPC output guard redirects them to stderr. Snapshot capture
  is request-local and must not mutate the SDK's shared UI context. RPC failures/
  timeouts remove the correlation listener; snapshots are not forwarded as
  conversation events.
- TUI sanitizes control characters and truncates lines to terminal width.
  Async completion after panel dismissal must not redraw or reopen it.

## Implementation

- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `external/pi-tools-suite/src/lsp/_shared/config.ts`
- `external/pi-tools-suite/src/lsp/_shared/types.ts`
- `external/pi-tools-suite/src/lsp/index.ts`
- `external/pi-tools-suite/src/lsp/renderer.ts`
- `external/pi-tools-suite/src/lsp/runtime-control.ts`
- `external/pi-tools-suite/src/lsp/local-runtime-control.ts`
- `external/pi-tools-suite/src/lsp/shared-manager.ts`
- `external/pi-tools-suite/src/lsp/broker-identity.ts`
- `external/pi-tools-suite/src/lsp/broker-client.ts`
- `external/pi-tools-suite/src/lsp/broker-server.ts`
- `external/pi-tools-suite/src/lsp/broker-wire.ts`
- `external/pi-tools-suite/src/lsp/broker-bootstrap.mjs`
- `external/pi-tools-suite/src/lsp/manager.ts`
- `external/pi-tools-suite/src/lsp/lsp-utils.ts`
- `external/pi-tools-suite/src/lsp/idle-cleanup.ts`
- `external/pi-tools-suite/src/lsp/constants.ts`
- `external/pi-tools-suite/src/lsp/async.ts`
- `external/pi-tools-suite/src/lsp/client.ts`
- `external/pi-tools-suite/src/lsp/child-process.ts`
- `external/pi-tools-suite/src/lsp/process-owner.ts`
- `external/pi-tools-suite/src/lib/lsp.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `acp/src/pi/pix-rpc-entry.js`
- `desktop/src/app/desktop-navigation-view-model-services.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/components/LspPanel.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/WorkspaceSidebarActivityBar.svelte`
- `desktop/src/lib/acp-client-types.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/acp-response-parsers.ts`
- `desktop/src/lib/sidebar-indicator-types.ts`

## Tests

- `external/pi-tools-suite/test/lsp.test.ts`
- `external/pi-tools-suite/test/lsp-reuse.test.ts`
- `external/pi-tools-suite/test/lsp-idle-cleanup.test.ts`
- `external/pi-tools-suite/test/helpers/manual-lsp-clock.ts`
- `external/pi-tools-suite/test/lsp-broker.test.ts`
- `external/pi-tools-suite/test/lsp-platform.test.ts`
- `external/pi-tools-suite/test/lsp-process-owner.test.ts`
- `external/pi-tools-suite/test/lsp-renderer.test.ts`
- `acp/test/agent.test.ts`
- `acp/test/desktop-commands.test.ts`
- `acp/test/pi-rpc-todo-clear.test.ts`
- `acp/test/pi-rpc-lsp.test.ts`
- `acp/test/pix-rpc-entry.test.ts`
- `desktop/src/lib/acp-client.test.ts`
- `desktop/src/lib/acp-response-parsers.test.ts`
- `desktop/src/components/LspPanel.test.ts`

## Verification

Run focused runtime/renderer/ownership tests, suite typecheck, ACP tests/build,
Desktop check/tests/web build, and Pix build with suite synchronization. The
POSIX ownership regression SIGKILLs an owner subprocess without hooks and
asserts disappearance of the server and its stubborn descendant. Runtime tests
cover lazy reuse, read-only command rejection, trust separation, failed startup,
late config/start cancellation and teardown. Real native Desktop and TUI QA
must separately check monitoring, dismiss/reopen and owner exit;
unit tests and web previews alone are not native/TUI QA evidence.

Independent-process regressions must prove simultaneous first edits yield one
server PID, repeated edits reuse it, closing the spawning client leaves the other operational,
and last-client graceful/forced exits remove the broker and owned descendants.
Verify project separation, reconnect/stale-endpoint recovery and trust isolation.
Hold a real shutdown grace window open while attaching a replacement and verify
the old owner exits before the new broker binds, whose endpoint/process survive.
The real SDK/ACP subprocess test checks edit-triggered reuse and monitoring without conversation
messages or an agent turn, not only direct broker-client calls.
