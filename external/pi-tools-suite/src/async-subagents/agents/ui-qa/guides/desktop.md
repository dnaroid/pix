# Native desktop backend router

Load this guide only after the common UI-QA role classified the requested
surface as `desktop`. Use the unified runner and its semantic desktop driver;
do not choose a platform automation stack yourself.

## Route by probe result

Desktop routing is capability-probed from the actual host. Write the common
flow, run `probe`, then load exactly the topic returned in `selection.guide`:

```sh
node "$PI_UI_QA_RUNNER" guide --backend desktop --topic macos-accessibility
node "$PI_UI_QA_RUNNER" guide --backend desktop --topic windows-uia
node "$PI_UI_QA_RUNNER" guide --backend desktop --topic linux-at-spi
```

Do not infer this topic from a project name or merely from the OS label. The
probe also verifies runtime dependencies/permissions. If it returns `BLOCKED`,
relay `blockedHandoff` and stop instead of installing automation packages,
changing privacy/accessibility settings, or substituting another surface.

Before `run`, the loaded topic must equal the authoritative `selection.guide`.

## Common desktop flow

Set `target.application` to an object containing exactly one supported
identity/launch contract. Never use a bare string such as
`"target":{"application":"dev.example.app"}`: that is not a desktop target
contract. Portable/common forms are `{"name":"App Name"}`,
`{"pid":1234}`, or a runner-owned launch such as
`{"launch":{"argv":["npm","run","dev"],"cwd":"desktop"}}`.
`{"bundleId":"dev.example.app"}` is macOS-only; use it only when the selected
detail guide allows it. The detail guide documents platform-specific identity
restrictions. Common steps are:

- window/control: `waitForWindow`, `activateWindow`, `activate`;
- inspection: `snapshotAccessibility`;
- input: `setValue`, `inputText`, `pressKey`;
- assertions: `waitForText`, `assertText`, `assertState`;
- evidence: `screenshot`, `capture`.

Semantic selectors use `path` or `name`, with optional `role` and `occurrence`.
Prefer stable application-owned names/roles/labels/IDs over coordinates.

Launch contracts must remain runner-owned and bounded. The runner permits only
the documented safe environment subset plus `PI_UI_QA_*` bootstrap variables
and injects `PI_UI_QA=1`. Do not daemonize the app or deliberately move it
outside the ownership boundary.

## Launch and readiness

Discover the application's documented launch contract before selecting an
executable. A development binary may depend on a separate frontend server or
other startup services; its existence does not make it a standalone build.
Prefer the documented project launch command that owns those dependencies, or
attach to an already running requested application. Do not launch a raw debug
binary unless its required services are confirmed ready. Missing prerequisites
are `BLOCKED`, not a reason to test an empty shell or substitute another surface.

Budget startup separately from UI interaction. Runner-owned launches default to
60 seconds for `waitForWindow`; that step accepts an explicit `timeoutMs` up to
90000, while other desktop steps stay capped at 30000. The whole run remains
bounded by `--runner-timeout-ms` (at most 100000); choose a budget that leaves
time for readiness, assertions, and cleanup. Do not rely on a short default
window wait for a launch command that performs a cold build.

If window discovery times out, inspect the retained `application.log` before
reporting an unavailable application. Distinguish a still-running build from
an exited launcher or a ready process without a window. A still-building launch
is not proof of a missing UI capability. Relay its stage and ask the parent to
complete the documented build prerequisites when they exceed the bounded launch
budget; do not retry the same short wait or substitute a raw debug binary.

`waitForWindow` proves only that a native window exists. Before testing the
requested behavior, wait for and assert an application-content readiness marker
from the real UI (for example a known editor, navigation control, or loaded
screen label). A window title, process name, or empty WebView is not a readiness
oracle. Keep readiness assertions separate from the requested behavior's
postcondition; a runner `PASSED` for window existence/title alone is not product
verification.

If content never becomes ready, retain a screenshot and accessibility snapshot
and distinguish a visually blank/unloaded window from a rendered UI whose
accessibility tree is empty. Report the unmet marker and the discovered launch
dependencies. Do not turn either case into a pass by asserting the window title.

## Oracles, evidence, cleanup

Prefer accessibility/app-driver state, window/dialog state, visible copy, and
enabled/checked/value state as deterministic oracles. Screenshots/videos are
supporting evidence. Repeated evidence actions may omit names; the runner gives
them collision-free filenames.

Inspect representative screenshots before visual claims. Let the runner clean
up only processes/windows it launched. Attached applications are externally
owned and must not be terminated; never broadly kill by application name.
