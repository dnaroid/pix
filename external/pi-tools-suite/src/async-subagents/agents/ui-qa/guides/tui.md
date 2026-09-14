# Terminal/TUI backend guide

Load this guide only after the common UI QA contract selected the
terminal/TUI backend. Use `$PI_SUBAGENT_AGENT_DIR/ui-qa/` for the declarative
flow and runner-owned evidence. Never edit application source, tests,
snapshots, or persistent user settings merely to make UI automation possible.

The backend has two universal presentation modes. Choose between them from the
task's required evidence and oracle, never from a project/app name or a
repository-specific heuristic:

- `presentation: "pty"` drives a real pseudo-terminal (PTY) plus the bundled
  headless ANSI/VT screen model. Reserve it for line-oriented/plain terminal or
  CLI programs, plus deliberately protocol-focused tests where terminal
  semantics—not a structured application's rendered UI—are the acceptance
  surface. Omitted presentation still maps to `pty` only for backward
  compatibility with existing flows.
- `presentation: "native-terminal"` keeps the target in the same runner-owned
  PTY used for deterministic input and semantic assertions, while mirroring that
  exact PTY byte stream into a fresh runner-owned native terminal window for
  pixel-faithful rendering evidence. Use it by default for structured/full-
  screen TUIs: panels, alternate-screen interaction, menus, focus/layout,
  colors, fonts/glyphs, special symbols, wrapping, clipping, or other visual
  terminal UI. The current implementation provides this mode on macOS through a
  fresh owned native-terminal process plus a private authenticated local bridge
  and the bundled accessibility/window-capture driver. Host selection is based
  on the environment/capabilities rather than the project: prefer iTerm2 when it
  is installed so evidence uses the user's iTerm rendering profile, and fall
  back to the built-in Terminal.app when iTerm2 is unavailable.

Nothing in either mode authorizes arbitrary shell or generic utility launchers.
The target command remains the same bounded project-local launch contract and is
always launched directly by the runner-owned PTY. Native-terminal mode does not
type or embed target argv/cwd/env into a terminal shell; its tiny private
bootstrap launches only the trusted bundled bridge with runner-generated
transport parameters.

## Flow contract

Set `target.command` to a bounded argv/cwd/env launch contract for the actual
shipping interactive program and optionally set `presentation`. Non-interactive
stdout from another CLI path is not a TUI verification.

`presentation: "pty"` supports:

- stability/navigation: `waitForStable`, `waitForText`
- input: `sendText`, `sendKeys` (named keys only; never embed control
  characters), `resize`
- assertions: `assertText`, `assertNotText`, `assertCursor`,
  `assertProcessRunning`, `assertProcessExited`
- evidence: `capture`

It also accepts an optional `viewport` with `cols`/`rows` when the scenario
depends on terminal dimensions.

`presentation: "native-terminal"` keeps these PTY semantic actions while adding
real-window evidence:

- stability/navigation: `waitForStable`, `waitForText`
- input: `sendText`, `sendKeys`
- assertions: `assertText`, `assertNotText`, `assertCursor`,
  `assertProcessRunning`, `assertProcessExited`
- evidence: `capture`

`viewport` and `resize` are not yet available in native-terminal mode because
the real terminal window geometry and the owned PTY must remain synchronized.
Cursor and process assertions remain valid deterministic PTY oracles; they are
not presented as pixel evidence.

Identify the actual launch command and the smallest user flow that proves the
requested behavior. Inspect only enough project metadata or source to find that
launch path and a stable automation surface. Input must be user-equivalent:
real keys through the PTY, never direct memory or signal manipulation.

In both modes, automated `sendText` and `sendKeys` enqueue user-equivalent input
into the same owned PTY, so semantic assertions and the native visual mirror
observe one target instance. In native-terminal mode the real terminal's stdin
and terminal-protocol responses are bridged back to that PTY as well. After
input that should change the visible state, use `waitForText` or `waitForStable`
before the corresponding assertion/capture.

## Oracles and evidence

Assert a deterministic product-visible result. TUI oracles may include visible
terminal text, focused/selected state exposed by the harness, cursor position,
or process state when that state is itself user-observable. A terminal capture
alone is evidence, not the only pass/fail oracle. Preserve failing captures
instead of weakening an assertion.

PTY runs automatically publish a bounded asciicast v2 replay in
`artifacts.videos`; it is terminal-state chronology, not pixel evidence, and
must never be presented as proof of exact colors/fonts/glyphs/window geometry.

Native-terminal runs keep the headless screen captures/asciicast as semantic
diagnostics, but mark the replay diagnostic-only. Each `capture` also publishes
a real-window screenshot and, when the platform grants exact-window recording,
a bounded MP4 of the owned native terminal window. Those real-window pixels are
the visual source of truth for rendering claims. They still do not replace
deterministic PTY assertions. Treat unavailable best-effort recording as a
separate evidence limitation. Inspect at least one representative screenshot
before claiming visual QA.

Report `PASS`, `FAIL`, or `BLOCKED`, the concrete oracle(s), launch/control
path, and every retained evidence file—including the terminal replay—as a
clickable Markdown link plus absolute path. For a failure, state expected
versus observed behavior without rewriting the acceptance criterion.

## Cleanup

Let the runner clean up only the PTY/process, private bridge, and fresh native
terminal host it launched. Never attach to, type into, or broadly kill an
unrelated user terminal window, and never signal processes the run did not
start.
