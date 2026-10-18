# Android ADB screenshots and coordinate input

An attach-only, emulator-only runner route. The app must already be foreground.
No APK installation, app-data access, launch/stop, permission/settings changes,
root, reboot, provider calls or raw ADB commands are supported. Never bypass the
runner with direct ADB. If prerequisites are missing, return BLOCKED to parent.
The primary visual route needs no XML/helper and writes no device files.
Do not start with `capture`, XML assertions or selector taps. First run a
`screenshot` flow and inspect the returned PNG with `read`. Choose coordinates
from that image, not from source code or a guessed layout; then run one bounded
interaction and inspect its before/after PNGs. Define the expected visible
screen/label before the action. Runner `PASSED` means commands completed, not
that the product-visible postcondition was verified; report that observation
separately. Unexpected screens, overlays or uncertain targets mean stop.

Example interaction after inspecting an 800x480 screenshot (coordinates are
illustrative, not a safe universal target):

```jsonc
{
  "version": 1,
  "target": {"android": {
    "adbPath": "/absolute/android-sdk/platform-tools/adb",
    "serial": "emulator-5580",
    "avdName": "your_dedicated_avd",
    "package": "your.app.package"
  }},
  "steps": [
    {"action": "tapPoint", "x": 400, "y": 240, "name": "open-screen"},
    {"action": "screenshot", "name": "inspect-result"}
  ]
}
```

Primary steps (only these fields plus `action`, optional `timeoutMs` 100..30000):

- `screenshot`: optional safe `name`; PNG only, never requests XML.
- `tapPoint`: integer `x`, `y`, optional safe `name`.
- `swipe`: integer `startX`, `startY`, `endX`, `endY`, optional `durationMs`
  100..2000 (default 300), optional safe `name`.
- `pressKey`: `key` BACK/ENTER/DEL/TAB/DPAD_UP/DOWN/LEFT/RIGHT/CENTER/ESCAPE.
  No HOME, power, volume or numeric keycodes. Surround keys with screenshots.

Coordinates are zero-based pixels of the current full-resolution PNG, not
host-window pixels, dp, percentages or natural-orientation `wm size` values.
The runner validates a fresh PNG and all coordinates against its actual width/
height, then sends one fixed input command with identity/foreground guards.
Each coordinate action retains `*-before.png` and, on success, `*-after.png`.
Failure preserves preceding evidence and never retries input. Bounds checks
do not identify the intended widget or make screenshot-to-input atomic: layout,
rotation and non-focusable overlay races remain. Inspect evidence, never claim
semantic or overlay isolation from coordinate bounds alone.

## Secondary XML actions

Use only when the task explicitly needs XML selectors/assertions. These are not
required by the visual route; idle or helper failures do not block `tapPoint`,
`swipe`, `pressKey` or `screenshot`.

- `capture`, `snapshotAccessibility`, `screenshot`: optional safe `name`.
- `assertText`, `waitForText`: exact nonempty `text`, matches text or content-desc
  of a non-password node belonging to the app. No substring/OCR assertion.
- `tap`: `selector` with exact `text`, `resourceId`, and/or `contentDesc`;
  optional zero-based `index`. Match exactly one enabled app node.
- `assertState`: `selector`, `attribute` (enabled/checked/selected/focused/clickable),
  boolean `equals`.
- `inputText`: safe ASCII `text` (letters/digits/spaces and `.,_@:+-`, max 200),
  only into a focused non-password app EditText. Cyrillic input is unsupported;
  assert Russian labels normally, but report non-ASCII typing as BLOCKED.
- `assertHelperCleanup`: after helper use, assert removal of this flow's own
  temporary directories and absence of helper processes. Optional `runId` is a
  strict 32-lowercase-hex lease ID from a prior cancelled flow. No deletion or
  process killing is performed; raw process data is not saved.

## Explicit no-idle helper

An exact `Android UIAutomator idle timeout; hierarchy unavailable` can occur
when an interface keeps emitting accessibility events. Do not keep retrying
stock dump or change animation/global settings. After the user explicitly
approves temporary helper files/execution on this dedicated AVD, set
`target.android.hierarchyMode` to `"no-idle"`. The default is `"stock"`; other
values and helper paths/bytes/commands are rejected. Probe remains read-only.

The runner verifies its pinned bundle and source hashes, then uses one exclusive
temporary transaction per hierarchy operation: create a private random
`/data/local/tmp/pi-ui-qa-*` namespace, run read-only UiAutomation without
waiting for idle, then remove/verify precisely that run's files. Nothing is
installed. ART per-process data/cache remain confined to its namespace. The
Java watchdog is 8s, shell timeout 10s; at least 13s must remain before helper
launch, and no-idle steps are bounded at 30s. A mandatory exact per-run terminal
status trailer is required because `exec-out` may hide remote process exits.
Missing/malformed/foreign/duplicate status fails closed; cleanup is unverified.
The cleanup assertion requires explicit directory/process acknowledgments and
records a read-only `exec-out false` diagnostic. A remote SIGKILL/adbd crash/
power loss can still leave files: never sweep other runs or kill processes.

If UiAutomation initially returns no root, the bundled `InitialRoot` policy
polls only that missing initial root for at most 1.5s (31 reads, 50ms apart),
within the unchanged Java watchdog. The first non-null root is immediately
subject to package/window identity guards; foreign roots and errors are never
retried. This is bounded root-readiness handling, not a general hierarchy retry.

Screenshots and coordinate actions do not require XML. No-idle selector taps/text input require two fresh snapshots
with identical node path/window, rotation, semantic/state/geometry, plus the
normal identity/foreground guards. A mismatch fails without input or retries.
This reduces transient-layout risk, but is not an atomic click or protection
against non-focusable overlays or the final read-to-input race. Preserve helper
lease observations on failure. Framed read-only home screenshot/XML/text and
cleanup passed. Selector navigation failed before input: only accessibility
`window-id` changed across helper sessions. This gate remains unchanged; use
the primary visual route, not more helper retries. Full schedule workflows
remain separately unverified.

Maintainers only: rebuild the committed bundle from `helper/HierarchyDump.java`
with Java17 and SDK platform35/build-tools35.0.0 using
`node drivers/android/helper/build-helper.mjs --sdk <SDK> --jdk <JDK17>`
(path relative to this agent's directory). The DEX minimum is API30. The runner
never builds or downloads helper dependencies at runtime.

Before device commands the runner checks the existing server's read-only
`host:version` protocol against local `adb version`; mismatch blocks without
letting adb connect/restart a shared daemon. It verifies emulator identity/boot
and focused app before and after steps. For Android versions where the
windows-only dump omits `mCurrentFocus`, the runner checks full `dumpsys window`;
missing, null, unparseable or different-package focus blocks. Screenshot
dimensions must match the natural or transposed screen size; screenshots do not
require XML. Selector tap bounds require XML and use its current rotation without
changing device orientation. `capture` saves the PNG before attempting XML.
Stock XML is read from the fixed `/proc/self/fd/1` transport and accepts only exact
status spellings; on transport/dump failure diagnostics expose safe booleans and
byte counts, not raw screen contents. Do not infer that XML works on every
socket-backed `exec-out` transport: live XML/capture/navigation may remain
blocked even when screenshot-only QA passes.
System/permission-dialog controls cannot be selected. Non-focusable system
overlays may still intercept coordinates despite the foreground check; stop if
an overlay is visible, rather than claiming complete overlay isolation.
XML is bounded and
password text redacted; PNG must match natural or transposed emulator dimensions. Artifacts are private
and may contain other visible personal data: do not navigate to credentials.
There is no video capability in this backend; report that limit honestly.

Use `screenshot` before/after key transitions so failures retain preceding evidence.
Inspect PNGs using `read` and preserve every returned artifact link. Resume keeps
prior evidence; use a fresh run ID for each new flow execution.
