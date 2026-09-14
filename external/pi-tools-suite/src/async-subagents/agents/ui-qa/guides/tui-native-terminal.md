# TUI detail: native terminal

Load this topic only when the TUI router or `selection.guide` selected
`native-terminal`. Set `target.command.presentation: "native-terminal"`.

## Presentation contract

The target still runs directly in the runner-owned PTY used for deterministic
input and semantic assertions. The runner mirrors that exact PTY byte stream
through a private authenticated local bridge into a fresh owned native terminal
window. Target argv/cwd/env are never typed into or embedded in a terminal
shell; the native window bootstrap contains only the trusted bridge plus
runner-generated transport parameters.

The runner discovers a native terminal host from current machine capabilities,
not project identity. Current platform providers are:

- macOS: iTerm2 when installed, otherwise Terminal.app;
- Windows: Windows Terminal;
- Linux: kitty, then Alacritty, GNOME Terminal, Konsole, then xterm.

The presentation is available only when the correlated platform desktop driver
can also capture the owned terminal window. Missing host/dependency/permission
returns `BLOCKED`; do not downgrade to headless evidence when pixel fidelity is
part of the requested proof.

## Flow surface

Supported PTY-semantic actions are:

- stability/navigation: `waitForStable`, `waitForText`;
- input: `sendText`, `sendKeys`;
- assertions: `assertText`, `assertNotText`, `assertCursor`,
  `assertProcessRunning`, `assertProcessExited`;
- evidence: `capture`.

`viewport` and `resize` are intentionally unavailable because the actual native
terminal geometry and owned PTY must stay synchronized. Never simulate a resize
that the real window did not perform.

Both automated input and terminal-protocol responses flow through the same PTY,
so semantic assertions and native visual evidence refer to one target instance.
After input, wait for observable/stable state before asserting or capturing.

## Evidence semantics

Headless screen captures and asciicast are retained only as semantic diagnostic
evidence and the replay is marked diagnostic-only. Each `capture` also retains
a real exact-window screenshot; those pixels are the visual source of truth for
rendering claims. macOS can additionally publish bounded exact-window MP4 when
Screen Recording/ScreenCaptureKit are available. Windows/Linux currently do not
advertise native-terminal window video.

Real-window evidence still does not replace deterministic PTY assertions.
Inspect at least one meaningful screenshot before claiming colors/layout/glyph
fidelity.

Cleanup is scoped to the owned target PTY, private bridge, and fresh terminal
host. Never attach to or close an unrelated user terminal window.
