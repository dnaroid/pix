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

Set `target.application` to exactly one supported identity/launch contract. The
detail guide documents any platform-specific identity restrictions. Common
steps are:

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

## Oracles, evidence, cleanup

Prefer accessibility/app-driver state, window/dialog state, visible copy, and
enabled/checked/value state as deterministic oracles. Screenshots/videos are
supporting evidence. Repeated evidence actions may omit names; the runner gives
them collision-free filenames.

Inspect representative screenshots before visual claims. Let the runner clean
up only processes/windows it launched. Attached applications are externally
owned and must not be terminated; never broadly kill by application name.
