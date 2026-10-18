# Android emulator QA router

Use this backend for an Android app inside an explicitly identified emulator,
not for the emulator's host window. No host Accessibility or extra dependency
installation is needed. This route only attaches to an existing foreground app.

Declare exactly one target: `target.android` with absolute `adbPath`, an explicit
`emulator-NNNN` serial, exact `avdName`, and app `package`. Never autodiscover or
fall back to USB/TCP devices. The local ADB server and emulator must already run.
The primary route is ADB screenshots plus `tapPoint`, `swipe` and `pressKey`,
with no XML, accessibility connection or temporary device files. Inspect a PNG,
choose current image-pixel coordinates, run a bounded interaction, then inspect
the retained before/after PNGs. Stop on visible overlays or unexpected screens.
Probe only checks the existing emulator/app; it never deploys a helper.
XML selectors/assertions are secondary, not a prerequisite or automatic fallback.
The optional `hierarchyMode: "no-idle"` helper requires separate user approval;
see the detail guide for its limits. Do not use it to unblock coordinate input.

Load the selected detail before probe/run:

```sh
node "$PI_UI_QA_RUNNER" guide --backend android --topic adb
```

Use the unified runner's private flow workspace and unique run IDs. Runner-owned
evidence is kept privately at `$PI_SUBAGENT_AGENT_DIR/evidence/<run-id>/`, outside
the disposable `ui-qa` directory, so old helpers that clear `ui-qa` should not
remove native Android evidence. A screenshot-only flow can verify a visual
observation without XML or interaction; it makes no assertions and proves no
navigation/workflow behavior. Retain every original artifact link. Evidence is
private and may contain visible personal data.
