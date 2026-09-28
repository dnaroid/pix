# TUI detail: PTY

Load this topic only when the TUI router or `selection.guide` selected `pty`.
Set `target.command.presentation: "pty"` explicitly in new flows.

## Flow surface

The runner drives one real pseudo-terminal and maintains a bundled headless
ANSI/VT screen model. Supported actions are:

- stability/navigation: `waitForStable`, `waitForText`;
- input: `sendText`, `sendPaste`, `sendKeys`, `resize`;
- assertions: `assertText`, `assertNotText`, `assertCursor`,
  `assertProcessRunning`, `assertProcessExited`;
- evidence: `capture`.

`sendKeys` uses documented named keys; do not embed control characters into
model-authored text. For a prompt pasted into an editor that supports bracketed
paste, use `sendPaste` followed by `sendKeys` Enter: paste delimiters prevent a
merged PTY read from treating Enter as part of the pasted text. `sendPaste` is
PTY-only and accepts bounded printable text. It fails safely if the target has
not enabled bracketed paste; use `sendText` for targets without support. Optional
`viewport` supplies `cols`/`rows`, and `resize`
may change them when terminal dimensions are part of the product contract.

After input expected to change the screen, prefer `waitForText` or
`waitForStable` before the corresponding assertion/capture. Cursor and process
assertions are valid only when that state itself is part of the user-visible
acceptance criterion. Visible-text assertions include the prompt/composer: a
word present in the submitted prompt cannot prove an assistant response. Wait
for a distinct response-only marker or other observable completion instead.

## Evidence semantics

Every PTY run automatically publishes a bounded asciicast v2 replay. It is a
terminal-state chronology, not pixel evidence: do not claim exact colors,
fonts, glyph rendering, or native window geometry from it. `capture` retains the
headless screen state for diagnosis.

If exact rendered terminal visuals are required, this is the wrong route; use
`native-terminal` rather than treating a headless rerender as visual proof.

Cleanup terminates only the runner-owned PTY/target. Do not signal unrelated
processes.
