# Desktop detail: macOS Accessibility

Load this topic only when `selection.guide.topic` is `macos-accessibility`.

The trusted bundled driver uses macOS Accessibility for semantic discovery and
interaction, CGWindow for window correlation/capture support, and
ScreenCaptureKit for exact-window recording when available. Do not invoke those
APIs directly from the QA child.

`target.application` may identify one application by `pid`, `name`, `bundleId`,
or a bounded runner-owned `launch` contract. Launch wrappers remain inside the
owned POSIX process group so the runner can correlate the real GUI descendant
and perform scoped cleanup.

Accessibility permission is required for semantic QA. Exact-window screenshots
require Screen Recording permission; exact-window MP4 additionally requires
the ScreenCaptureKit window-stream capability. Probe advertises these
independently and returns remediation when permissions/toolchain are missing.
Never change macOS privacy settings from this child.

Supported semantic actions/selectors are those in the desktop base guide.
Prefer Accessibility roles/names/state as the oracle. Supported runs attempt a
silent exact-window video automatically; no extra recording action is needed.
The recorder scales the captured independent window to fill its Retina output
surface, so the window rather than an oversized empty canvas is the visual
evidence.

Attached applications remain externally owned. For launched applications,
cleanup is limited to the runner-owned process group and correlated GUI target.
