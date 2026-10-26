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
The helper cache/release build includes all three Swift sources; its signing identifier
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
Prefer Accessibility roles/names/state as the oracle. Generic supported runs attempt a
silent exact-window video automatically; no extra recording action is needed.
The recorder scales the captured independent window to fill its Retina output
surface, so the window rather than an oversized empty canvas is the visual
evidence.

Attached applications remain externally owned. For generic launched applications,
cleanup is limited to the runner-owned process group and correlated GUI target.

If `waitForWindow` times out, report its retained `last lookup` diagnosis:
`no running app matches` is a selection/registration problem, while an app name
and PID with `no accessible window` means application lookup succeeded but no
AX window was available. Neither alone proves whether the app rendered. Do not
repeat the same launch blindly or declare the UI verified from the build log.
