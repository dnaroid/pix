# Terminal/TUI backend router

Load this guide only after the common UI-QA role classified the requested
surface as `tui`. The actual program must run through the unified runner's owned
PTY; never replace an interactive UI request with captured stdout from another
CLI path.

## Choose one presentation route

Choose from the user-facing acceptance surface, never from an application or
repository name:

- line-oriented/plain terminal or deliberately protocol-focused checks where
  text/cursor/process/resize/ANSI semantics are the product -> `pty`;
- structured/full-screen terminal UI where rendered layout, colors, glyphs,
  menus, wrapping, clipping, focus, or terminal-window fidelity matter ->
  `native-terminal`.

Load exactly one detail topic:

```sh
node "$PI_UI_QA_RUNNER" guide --backend tui --topic pty
node "$PI_UI_QA_RUNNER" guide --backend tui --topic native-terminal
```

For every new flow, explicitly set `target.command.presentation` to the route
you selected. Omission remains accepted only for old-flow compatibility. If the
requested visual fidelity requires `native-terminal` and probe blocks it, relay
the blocker rather than silently downgrading to PTY evidence.

After `probe`, `selection.guide` is authoritative and must equal the detail
topic you are following before `run`. If it differs, load the returned topic and
reconcile the flow first.

## Common TUI flow

Set `target.command` to the bounded argv/cwd/env launch contract for the actual
shipping interactive program. Generic shells, arbitrary utility launchers, and
inline-code execution are not an automation escape hatch. The runner launches
the target directly in its owned PTY.

Input must be user-equivalent. Define the expected visible/interactive
postcondition before sending keys, and wait for observable text or a stable
frame before asserting asynchronous state changes. The detail guide defines the
supported actions and evidence for its presentation.

Use only the documented bounded environment fields and project-local launch
paths. Do not edit product source/tests/settings or signal/mutate target state
behind the UI merely to make the flow pass.

## Oracles, evidence, cleanup

Deterministic terminal text/cursor/process assertions are the pass/fail oracle
when those states are product-visible. Pixel captures and terminal recordings
explain the result and do not replace assertions. Preserve failing evidence.

Let the runner clean up only the PTY/process and presentation resources it owns.
Never attach to, type into, or broadly terminate unrelated user terminal
windows/processes. Report every retained artifact and inspect representative
PNG evidence before making visual rendering claims.
