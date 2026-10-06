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

Accessibility permission is required for semantic QA. Exact-window screenshots
require Screen Recording permission; exact-window MP4 additionally requires
the ScreenCaptureKit window-stream capability. Probe advertises these
independently. When Accessibility is missing the blocked probe returns
remediation; when only Screen Recording is missing, inspect
`missingCapabilities` and ask the user to approve the same helper under Screen
Recording before claiming visual evidence.
Never change macOS privacy settings from this child.

Supported semantic actions/selectors are those in the desktop base guide.
Prefer Accessibility roles/names/state as the oracle. Supported runs attempt a
silent exact-window video automatically; no extra recording action is needed.
The recorder scales the captured independent window to fill its Retina output
surface, so the window rather than an oversized empty canvas is the visual
evidence.

Attached applications remain externally owned. For launched applications,
cleanup is limited to the runner-owned process group and correlated GUI target.

If `waitForWindow` times out, report its retained `last lookup` diagnosis:
`no running app matches` is a selection/registration problem, while an app name
and PID with `no accessible window` means application lookup succeeded but no
AX window was available. Neither alone proves whether the app rendered. Do not
repeat the same launch blindly or declare the UI verified from the build log.
