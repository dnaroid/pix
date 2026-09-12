# Native desktop backend guide

Load this guide only after the common UI QA contract selected the native
desktop backend. Use `$PI_SUBAGENT_AGENT_DIR/ui-qa/` for the declarative flow
and runner-owned evidence. Never edit application source, tests, snapshots, or
persistent user settings merely to make UI automation possible.

The bundled macOS backend exposes semantic accessibility actions; other
unsupported platform drivers return `BLOCKED`. Do not install GUI automation
packages, disable sandboxing, change OS accessibility/privacy settings, or take
control of unrelated user windows.

## Flow contract

Set `target.application` to exactly one of `pid`, `name`, `bundleId`, or a
bounded project-local `launch` contract. Supported steps are:

- windows: `waitForWindow`, `activateWindow`, `activate`
- inspection: `snapshotAccessibility`
- input: `setValue`, `inputText`, `pressKey`
- assertions: `waitForText`, `assertText`, `assertState`
- evidence: `screenshot`, `capture`

Semantic element selectors use `path` or `name`, with optional `role` and
`occurrence`. Identify the actual application and the smallest user flow that
proves the requested behavior; inspect only enough project metadata or source
to find that launch path and a stable automation surface.

Input must be user-equivalent: accessibility/app-driver actions against
identifiable controls and windows. Prefer stable names, labels, roles, test
ids, window titles, and application-owned IDs over screen coordinates.
Coordinate-only input is a last resort and must be paired with a postcondition
that proves the intended target was affected.

## Oracles and evidence

Assert a deterministic product-visible result. Desktop oracles should prefer
accessibility/app-driver state, window/dialog state, visible copy,
enabled/checked/value state, or another explicit application result. A
screenshot alone is evidence, not the only pass/fail oracle.

Supported macOS runs automatically publish a silent exact-window video; no
extra flow action is required. The recording explains chronology but never
replaces a deterministic assertion. Treat an unavailable best-effort recording
as a reported evidence limitation, not by itself as a product failure. If
screenshots are present, inspect at least one representative PNG with the
`read` tool before claiming visual QA; record the inspected path and concrete
findings. If image reading or screenshot capture is unavailable, report that
limitation separately from deterministic functional assertions.

Report `PASS`, `FAIL`, or `BLOCKED`, the concrete oracle(s), launch/control
path, and every retained evidence file—including the window video—as a
clickable Markdown link plus absolute path. For a failure, state expected
versus observed behavior without rewriting the acceptance criterion.

## Cleanup

Let the runner clean up only the app/driver process it launched. Attached
applications are not runner-owned and must not be terminated. Never broadly
kill by app name when that could terminate an unrelated user session.
