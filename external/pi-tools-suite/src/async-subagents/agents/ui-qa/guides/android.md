# Android QA router

Use this backend for an Android app on an explicitly selected emulator or physical device,
not for the emulator's host window. No host Accessibility or extra dependency
installation is needed. This route attaches to an existing target. A fresh flow normally requires
the target app foreground; its first `appLifecycle: resume` step may attach
from HOME to recover a backgrounded app.

Declare exactly one target: `target.android` with absolute `adbPath`, an explicit
app `package`, and one of:
- Emulator (default): `emulator-NNNN` serial and exact `avdName`.
- Physical (explicit opt-in): `deviceType: "physical"`, exact transport `serial`
  and hardware `deviceSerial` (`ro.serialno`); omit `avdName`. USB, TCP/IP,
  IPv6 and mDNS transport labels are supported, not ADB selector prefixes.

Never autodiscover or substitute devices. The parent/user must identify the
transport and expected hardware serial; if unknown, return BLOCKED. The runner
checks both identities, non-emulator properties, boot ID and foreground package.
The local ADB server and selected target must already be available.
The primary route is ADB screenshots plus `tapPoint`, `swipe` and `pressKey`,
with no XML, accessibility connection or temporary device files. Inspect a PNG,
choose current image-pixel coordinates, run a bounded interaction, then inspect
the retained before/after PNGs. Stop on visible overlays or unexpected screens.
Probe only checks the existing target/app; it never deploys a helper.
Stock XML selectors/assertions are secondary, not a prerequisite or automatic fallback.
UIAutomator may temporarily disrupt accessibility services; prefer screenshots.
`appLifecycle` is a separately user-authorized bounded extension, not general
device control: obtain explicit user authorization in the QA task before using
it; no flow-level grant field exists. It supports background/resume of
only the selected package (restart is emulator-only) and captures before/after screenshots. The runner
issues no direct app-data read/clear commands; ordinary lifecycle state may be
saved by the app. Without that user authorization,
use the existing foreground-only route. The optional
`hierarchyMode: "no-idle"` helper requires separate user approval and is
emulator-only. Physical devices also prohibit helper-cleanup assertions;
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
