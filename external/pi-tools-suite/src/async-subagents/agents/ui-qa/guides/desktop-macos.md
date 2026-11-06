# Desktop detail: macOS Accessibility

Load this topic only when `selection.guide.topic` is `macos-accessibility`.

In source/development runs, the trusted driver is installed once per OS user at
`~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility`.
The account home comes from the OS, not an isolated QA app's temporary HOME.
Projects share this signature-checked installation; project Registry Clean and
scratch TTL cleanup cannot remove it. A matching private old project helper may
be copied after signature verification, without recompiling or deleting it.
Do not use the old `.pi/ui-qa/helpers/macos-accessibility` path for new requests.
Installed macOS TUI and
Desktop releases use their signed payload's `helpers/macos-accessibility`
instead; a missing/invalid packaged helper requires reinstalling the complete
release rather than compiling one into the project. The probe remediation
names the actual helper executable that requires approval.
Its signing identifier is `org.pix.ui-qa.macos-accessibility`; the helper may
need its own Accessibility and Screen Recording approvals in System Settings
even when Pix Desktop is already approved. An ad-hoc signed helper retains
grants for unchanged builds but may need user reapproval after a source update;
`PI_UI_QA_MACOS_CODESIGN_IDENTITY` can select an available keychain signing
certificate for development; releases use their Apple signing identity. A
certificate-based designated requirement can remain stable across updates.
Check `doctor` again in a new run; do not claim that a screenshot exists without
Screen Recording permission. The driver uses macOS Accessibility for semantic
discovery and interaction, CGWindow for window correlation/capture support, and
ScreenCaptureKit for exact-window recording when available. Do not invoke those
APIs directly from the QA child.

For missing permissions, hand off the exact helper path returned by the probe.
The user/parent can explicitly run `"<helper path>" doctor --prompt` to request
Accessibility and Screen Recording. The QA child must not request permission
dialogs on its own. The request does not grant permission and may return
`missing` before the user responds; after approval run `doctor` without
`--prompt` in a fresh process. If no dialog appears, the user must add/enable
that exact helper in System Settings > Privacy & Security > Accessibility and
Screen Recording. Never reset TCC or grant permissions programmatically.
Moving a helper or changing its signing identity can require fresh approval;
a permanent path is not a promise of permanent TCC grants.

`target.application` may identify one application by `pid`, `name`, `bundleId`,
or a bounded runner-owned `launch` contract. Launch wrappers remain inside the
owned POSIX process group so the runner can correlate the real GUI descendant
and perform scoped cleanup.

For generic app targets, `menuActivation` enables `activateMenu` through the
trusted driver. It resolves an exact title path in the selected app's menu bar,
opens each submenu, and presses the final item with AXPress. Missing, ambiguous
or disabled items fail; errors list available titles for discovery. It never
searches another application's menu bar or uses coordinate fallback. This does
not enable direct AppleScript/Accessibility calls from the QA child.

The capability is advertised only when Accessibility is available and
`doctor` reports `menu_activation=available`; an older helper binary must not
be treated as supporting it. Use the desktop base guide's bounded `path` array
of exact menu titles.

When `doctor` reports `window_targeting=available` and Accessibility is
available, element inspection and interaction steps may specify an exact
top-level `windowTitle` to target an app-owned window directly, without relying
on `AXFocusedWindow`, focus changes, or coordinate fallback. The selected
window's AX paths are local to that window. `windowTitle` is the native AX
window title, which can differ from the caption visibly painted by Qt or
another toolkit; discover available native titles and do not infer a match from
the caption. `waitForWindow` also accepts `windowTitle` and polls for that exact
native title before later inspection. Exact selection fails closed when
missing or ambiguous. For mGBA, visible caption `Скрипты` matched no native
window in the completed probe; candidate `Window` contained only a
`WindowSharingSessionButton` overlay and is conclusively not the REPL. Do not
use it as an mGBA window target. The final bounded probe waits for the exact
native title `Скрипты` to distinguish delayed registration from an inaccessible
Qt tool window. General safe sequence:

```json
{"action":"waitForWindow","windowTitle":"Скрипты","timeoutMs":15000}
{"action":"snapshotAccessibility","windowTitle":"Скрипты"}
{"action":"assertText","windowTitle":"Скрипты","text":"Запустить"}
{"action":"setValue","windowTitle":"Скрипты","selector":{"path":"0.0.0"},"value":"dofile(\"/absolute/path/tools/mgba_bridge.lua\")"}
```

The identifying assertion is mandatory before interaction; the selected native
title itself is not proof that this is the intended REPL. This option is
supported on `waitForWindow`, `snapshotAccessibility`, `activate`, `setValue`,
`waitForText`, `assertText`, and `assertState`; it does not apply to screenshots,
capture, window activation, or keyboard actions. Omitting it retains the
existing focused-window behavior.

For long console/REPL output, `waitForText` and `assertText` also accept a
semantic `selector` and read the complete text attribute of that accessibility
record, rather than relying on the truncated tree summary. Combine it with the
exact native `windowTitle`; use a path discovered from that window's snapshot.
Native record string fields are bounded to 16,384 characters each; compact tree
summaries remain abbreviated and secure-text redaction remains in effect.

## Bounded TextEdit synthetic fixture

Only for an explicitly authorized synthetic smoke, use
`target.application: { "fixture": "texteditBlank" }`. This fixed macOS-only route
cannot be combined with selectors or launch settings. It refuses an already-running
TextEdit. A native supervisor opens `/System/Applications/TextEdit.app` through
LaunchServices `NSWorkspace.OpenConfiguration`, requesting a new instance without
substitution, activation, prompts, or recent-item registration. Fixed per-process
no-restore/untitled flags do not change persistent defaults, HOME, or environment.
The completion `NSRunningApplication` is retained and compared with `isEqual`;
PID supports diagnostics/AX correlation only, never ownership or reconstruction.
The sole-instance, blank untitled document, live focus, and AX identity guards—not
launch flags alone—control admission. Missing/ambiguous evidence means no input.

Include exactly one `{ "action": "texteditSmoke" }` (optional `timeoutMs`);
only `snapshotAccessibility` may accompany it (fixed depth 10, at most 100 nodes,
inside the retained-handle supervisor). Screenshots, video and generic companion
actions are rejected before launch; there is no PID-based evidence fallback.
For a separately authorized zero-key launch/blank check use
`{ "fixture": "texteditBlankLifecycle" }`, which requires zero smoke actions.
The fixed smoke posts seven paired synthetic global HID key events for `ghbdtn `,
including the trailing space. It requires U.S. or ABC layout, no secure input or
active modifiers, checks the live focused-app PID and the same AX element, and
confirms exact text after every key. Mismatch stops without retry or repair. Generic
`pressKey` support is unchanged; do not replace this route with Unicode `inputText`.

This is not proof of physical input origin or product event counters. Preflight to
launch and focus check to event post are not atomic. TextEdit may autosave the new
document; do not inspect/delete its user container. **Close TextEdit manually only.**
No fixture outcome permits terminate/forceTerminate, PID/group signals, UI close,
Cmd+Q, or a reaper. Release removes helper observers/pipes; only that directly spawned
helper may be killed at the parent's 5-second release ceiling. Native launch waits
up to 15 seconds, with a 3-second late-callback drain after abandonment; the parent
ceiling fits the runner's 10-second hard grace. EOF, signals and timeouts permanently
revoke input. Late callbacks may add diagnostics but never restore permission.

Smoke status and `texteditCleanup` are separate: `manualRequired` means a retained
handle without confirmed exit; `unknown` means no completion or lost supervisor;
`confirmed` requires retained `isTerminated` plus absence of an equal running instance;
`notNeeded` means no LaunchServices request. After a sent launch, crash/kill keeps
`manualCloseRequired=true` unless no launch or exit was confirmed. A PASS smoke is
not an automatically completed lifecycle. Inspect windows and unsaved documents
before manually closing; never recommend discarding unknown content. Close before
another launch; do not retry after an ambiguous result. Failure stops input; automated
tests do not prove runtime delivery or that LaunchServices fixes an OS signature kill.
The helper cache/release build includes the closed Swift source set from
`helper-sources.mjs`, including menu navigation; its signing identifier
is unchanged. An ad-hoc rebuild may need user reapproval; never reset TCC.

Accessibility permission is required for semantic QA. Exact-window screenshots
require Screen Recording permission; exact-window MP4 additionally requires
the ScreenCaptureKit window-stream capability. Probe advertises these
independently. When Accessibility is missing the blocked probe returns
remediation; when only Screen Recording is missing, inspect
`missingCapabilities` and ask the user to approve the same helper under Screen
Recording before claiming visual evidence.
Never change macOS privacy settings from this child.

Supported semantic actions/selectors are those in the desktop base guide.
Prefer Accessibility roles/names/state as the oracle. Generic supported runs attempt an
exact-window video automatically; it is silent unless authorized opt-in app audio
recording is requested below.
The recorder scales the captured independent window to fill its Retina output
surface, so the window rather than an oversized empty canvas is the visual
evidence.

### Game input

When advertised by the probe, macOS `gameInput` provides one bounded synthetic
input action. Delivery defaults to `pid` (target process). Explicit
`delivery: "foreground"` instead posts system HID events and requires explicit
authorization; use it only when the task authorizes foreground system input.
It accepts up to eight distinct lowercase keys from `a`–`z`,
`0`–`9`, `space`, `shift`, `ctrl`, `escape`, `enter`, `tab`, `left`, `right`,
`up`, `down`; duration is 20–5000 ms (default 100), `dx`/`dy` are integers in
−2000..2000 (default 0), and optional `button` is `left` or `right`. Set the
step's `timeoutMs` to at least `durationMs + 2000` for setup and release. Keys
are automatically released when the action completes or is cooperatively
cancelled; no key lease persists across steps. Focus loss, target loss, parent
loss, and cooperative SIGTERM/SIGINT cancellation stop the action. Do not
assume release is guaranteed after SIGKILL, crash, or other uncooperative
termination. Foreground mode checks focus, parent ownership, target liveness,
and cancellation before downs and pointer motion, but checking and posting are
not atomic: a focus race remains. Requested keys/buttons already held are
refused in foreground mode. On cancellation, releases for posted downs still
go to the HID event stream even if focus was lost. There are no arbitrary
Command/Option shortcut modifiers. This is intended for games without semantic
controls; it does not establish game-side event-counter results or runtime
verification of any particular game.

Examples (include each step in the flow's `steps` array):

```json
{"action":"gameInput","keys":["w","shift"],"durationMs":800,"timeoutMs":3000}
{"action":"gameInput","dx":240,"dy":-60,"durationMs":250,"timeoutMs":2250}
{"action":"gameInput","button":"left","durationMs":120,"timeoutMs":2120}
```

To explicitly select the foreground route for an authorized task, add
`"delivery":"foreground"` to the step, for example:

```json
{"action":"gameInput","delivery":"foreground","keys":["w","shift"],"durationMs":800,"timeoutMs":3000}
```

Do not add an unrequested shortcut or assume focus validation eliminates the
check/post race. Use default PID delivery unless foreground input is authorized.

An explicitly authorized non-fixture desktop flow may set top-level
`recordAppAudio: true` to request audio with the exact-window video. For example,
add this property beside `target` and `steps` in the flow object:

```json
{"target":{"application":{"name":"Example Game"}},"recordAppAudio":true,"steps":[{"action":"waitForWindow"}]}
```

This option is not available for fixtures. It
requires macOS 13+, Screen Recording and the video recorder capability. Audio
is selected-application audio, including that app's other windows; it is not
isolated to the captured window and does not include microphone input. Default
window video remains silent and best-effort, but explicitly requested audio
that cannot start or finalize fails the flow.

Attached applications remain externally owned. For generic launched applications,
cleanup is limited to the runner-owned process group and correlated GUI target.

If `waitForWindow` times out, report its retained `last lookup` diagnosis:
`no running app matches` is a selection/registration problem, while an app name
and PID with `no accessible window` means application lookup succeeded but no
AX window was available. Neither alone proves whether the app rendered. Do not
repeat the same launch blindly or declare the UI verified from the build log.
