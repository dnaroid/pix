# Desktop detail: Windows UI Automation

Load this topic only when `selection.guide.topic` is `windows-uia`.

The trusted bundled PowerShell/.NET helper uses Windows UI Automation for
semantic discovery, interaction, and state assertions. Exact-window PNG capture
uses the bounded Win32 capture path exposed by that helper. The QA child must
not execute arbitrary PowerShell automation itself.

`target.application` may use `pid`, `name`, or a bounded runner-owned `launch`
contract. `bundleId` is not a Windows identity. For launched applications the
launcher PID is an owned process-tree root; UI Automation correlates the actual
GUI descendant before interaction and the runner retains that GUI PID as an
additional scoped cleanup root.

Probe verifies that UI Automation can initialize in the current interactive
desktop session and separately reports screenshot capability. Window video is
currently unavailable and must remain an explicit missing capability rather
than being synthesized from screenshots.

Use the common desktop semantic actions/selectors. Prefer UIA role/name/state
oracles, retain PNG evidence when available, and never terminate an externally
attached application or an unrelated process with the same name.
