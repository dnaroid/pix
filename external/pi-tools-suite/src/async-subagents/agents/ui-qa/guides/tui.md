# Terminal/TUI backend guide

Load this guide only after the common UI QA contract selected the
terminal/TUI backend. Use `$PI_SUBAGENT_AGENT_DIR/ui-qa/` for the declarative
flow and runner-owned evidence. Never edit application source, tests,
snapshots, or persistent user settings merely to make UI automation possible.

The runner drives the target through a real pseudo-terminal (PTY) and headless
terminal emulator; it owns the PTY lifecycle, screen model, evidence, and
cleanup. Nothing in this guide authorizes shell or generic utility launchers —
the runner enforces a bounded project-local launch contract and rejects unsafe
primitives.

## Flow contract

Set `target.command` to a bounded argv/cwd/env launch contract for the actual
shipping interactive program. Non-interactive stdout from another CLI path is
not a TUI verification. Supported steps are:

- stability/navigation: `waitForStable`, `waitForText`
- input: `sendText`, `sendKeys` (named keys only; never embed control
  characters), `resize`
- assertions: `assertText`, `assertNotText`, `assertCursor`,
  `assertProcessRunning`, `assertProcessExited`
- evidence: `capture`

Capture the terminal state needed to support each assertion. Set an optional
`viewport` with `cols`/`rows` when the scenario depends on terminal dimensions.

Identify the actual launch command and the smallest user flow that proves the
requested behavior. Inspect only enough project metadata or source to find that
launch path and a stable automation surface. Input must be user-equivalent:
real keys through the PTY, never direct memory or signal manipulation.

## Oracles and evidence

Assert a deterministic product-visible result. TUI oracles may include visible
terminal text, focused/selected state exposed by the harness, cursor position,
or process state when that state is itself user-observable. A terminal capture
alone is evidence, not the only pass/fail oracle. Preserve failing captures
instead of weakening an assertion.

TUI runs automatically publish a bounded asciicast v2 replay in
`artifacts.videos`; no extra flow action is required. The replay explains
chronology but never replaces a deterministic assertion. Treat an unavailable
best-effort recording as a reported evidence limitation, not by itself as a
product failure. When captures/screenshot-like evidence is present, inspect at
least one representative artifact with the `read` tool before claiming visual
QA; if image reading is unavailable, report that limitation separately from
deterministic assertions.

Report `PASS`, `FAIL`, or `BLOCKED`, the concrete oracle(s), launch/control
path, and every retained evidence file—including the terminal replay—as a
clickable Markdown link plus absolute path. For a failure, state expected
versus observed behavior without rewriting the acceptance criterion.

## Cleanup

Let the runner clean up only the PTY/process it launched. Never broadly kill by
app name when that could terminate an unrelated user session, and never signal
processes the run did not start.
