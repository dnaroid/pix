# UI QA sub-agent specification

## Type

As-is

## Lifecycle

Active implemented contract.

## Goal

Provide a cheap, fast `ui-qa` async-subagent that reproduces user-visible bugs
and proves fixes across browser/web UI, terminal/TUI applications, and native
desktop GUIs and explicitly selected Android apps/devices. Browser QA uses one Chrome Control driver: macOS Apple Events against the
running Google Chrome, opening one owned tab in the current profile with manual
sign-in, and no headless, isolated-browser, DevTools, video, or trace evidence. Native/TUI QA uses a real PTY or
deterministic app/platform UI driver and retains inspectable captures plus
automatic bounded video evidence when the backend supports it.
Its ranked `models` list prefers `zai/glm-5.3-flash`, then
`openai-codex/gpt-6-luna`, filtered by confirmed runtime image support and
current-session model availability.

## Inline agent workflow and skill isolation

- The bundled role is a thin common contract: `src/async-subagents/agents/ui-qa.md`
  keeps only the shared invariants (real target, backend classification,
  `BLOCKED` semantics, deterministic-assertion oracle, bounded execution, owned
  cleanup, private evidence) plus the base-guide/probe/run invocation syntax.
  It deliberately omits browser-provider, terminal-presentation,
  desktop-platform, and credential implementation details. Its body becomes the
  QA child's `promptAppend` through the shared agent loader. Parent and router
  catalogs include only its short `description`.
- Backend-specific instructions live in the canonical resource tree under
  `src/async-subagents/agents/ui-qa/guides/`. `browser.md` is the complete browser guide, and `tui.md` and
  `desktop.md` are compact base routers. Detail topics are TUI `pty`/`native-terminal`, and desktop
  `macos-accessibility`/`windows-uia`/`linux-at-spi`. The child first loads only
  its matching base guide through
  `node "$PI_UI_QA_RUNNER" guide --backend browser|tui|desktop`, then only the
  routed detail topic. The command resolves bundled files from a fixed
  backend-scoped allowlist, rejects unknown or cross-backend topics, unknown
  options, extra arguments, and traversal, bounds guide size, and prints only
  the requested document; the model never composes or reads source paths.
- The capability-first runner lives under
  `src/async-subagents/agents/ui-qa/`, with browser, PTY/TUI, and platform
  desktop accessibility backends for macOS, Windows, and Linux. The browser backend is the
  Chrome Control driver under `agents/ui-qa/drivers/chrome-control/` (macOS
  Apple Events; no vendored browser runtime and no DevTools adapter). None of these assets, including the guides, is a discoverable
  skill or agent role (`agents/*.md` discovery stays non-recursive and
  top-level only).
- Sub-agent processes disable normal extension discovery, then always load the
  suite's model-tools extension. They load the Antigravity provider extension
  only when an Antigravity model is explicitly selected. The launcher appends
  `--models <effective-model>` after forwarded arguments so persisted model
  patterns cannot resolve unrelated providers inside the isolated child.
- Every async sub-agent launches with `--no-skills`. `--skill` and
  `--skill=...` flags are removed from `extraArgs`, and role profiles have no
  skill-loading field. The thin agent Markdown plus its on-demand bundled
  guides are the complete role instruction source.
- `ui-qa` is the only built-in UI-QA role name. `browser-qa` is not an alias;
  a project-local `browser-qa.md` is an ordinary independent project role and
  receives no UI-QA special treatment. The Chrome Control driver is bundled
  with `ui-qa`; it does not load the `chrome-control` skill.
- The launcher sets `PI_UI_QA_RUNNER` to the absolute capability-first runner, replacing inherited values and stripping it from ordinary children. QA uses the unified runner for guide, probe, and run; no browser runner is exposed to the child.
- A project `ui-qa.md` completely replaces the bundled role profile. It does
  not inherit bundled model/tool/thinking fields or Markdown instructions, so
  projects must explicitly carry forward every bundled field/instruction they
  still require. Runtime protections remain in the runner and are not prompt
  boundaries.

## Android target contract

Android QA defaults to the existing AVD-only contract: explicit emulator
transport serial, exact AVD name and target package. Physical-device QA is
opt-in with `deviceType: "physical"`, exact transport `serial` and expected
hardware `deviceSerial` (`ro.serialno`); omit `avdName`. The parent/user must
supply identities; unknown targets are BLOCKED, never discovered/substituted.
Explicit USB, TCP/IP, IPv6 and mDNS transport labels are supported. The runner
checks exact transport serial, hardware identity, non-emulator properties,
boot ID and focused target package at guards. Generic hardware serials are not
cryptographic identity; the final guard-to-input TOCTOU interval remains.

Use runner-owned screenshots/coordinate input first. Stock XML is optional and
may temporarily disrupt accessibility services; screenshots may capture
notifications or other visible personal data. Physical targets prohibit the
no-idle helper, helper-cleanup assertions and restart. Separately authorized
background/resume remains available. There is no support for installation,
data clear, permission/settings changes, root, reboot or starting an ADB daemon.
The base/detail guides are `android.md`/`android-adb.md`, loaded through
`guide --backend android` and `guide --backend android --topic adb`.

## Browser launch and authentication contract

- The browser backend is Chrome Control only (`drivers/chrome-control/`). It
  drives the already-running Google Chrome through macOS Apple Events; the runner
  launches no browser and never installs one. Missing Chrome, the Automation or
  Apple Events permissions, or Screen Recording for screenshots returns
  `BLOCKED`; there is no fallback driver.
- Instance selection ignores same-bundle background Chrome processes (for
  example a silent updater). Without a pinned instance, exactly one regular GUI
  Chrome application must be running: none returns `chrome-not-running`, and
  several return `chrome-instance-ambiguous` (`BLOCKED`) without touching any
  tab. Each operation targets the selected PID through JXA and re-checks its
  launch timestamp; a replaced or exited process returns `chrome-not-running`.
  Multiple windows or profiles inside that one instance are allowed; the tab
  still uses the front window's current profile.
- The runner opens one owned tab in the front Chrome window. That tab shares the
  current profile's cookies and session; it is not isolated. Sign-in, MFA and
  CAPTCHA are manual in Chrome. The QA child must not automate login, embed
  credentials, or access stored credentials.
- The runner does not read or create `.pi/qa_auth.jsonc`. Browser QA has no auth
  profile and no update-required auth status.
- The origin is checked before acting on the owned tab. Redirects and subresource
  traffic are not blocked, so network isolation is not claimed.

## Native/TUI execution contract

- The QA target must be the actual user-facing TUI or desktop application named
  by the task. Repository tests, snapshots, source inspection, or a different
  CLI/web surface may support discovery but cannot substitute for requested UI
  execution.
- The launcher creates a private `ui-qa/` workspace under the owning agent
  directory. Native/TUI transcripts, captures, screenshots, videos, and small
  temporary driver artifacts stay there and are removed with the sub-agent run.
- Repeated unnamed Desktop evidence steps receive collision-free filenames
  based on their action and step index. Explicit names remain available when a
  stable human-readable artifact label is useful.
- Terminal/TUI verification is selected from `target.command`, with an explicit
  presentation contract that is independent of project/app identity.
  New QA flows choose presentation explicitly by surface category: `pty` is for
  line-oriented/plain terminal/CLI programs or protocol-focused semantic tests,
  while `native-terminal` is the normal presentation for structured/full-screen
  TUIs. Omitted presentation remains a `pty` compatibility default for older
  flows only. Native-terminal covers real-window colors, fonts/glyphs, special
  symbols, wrapping, clipping, menus/focus, and pixel geometry.
  The target still runs in the runner-owned PTY used for deterministic input and
  semantic assertions; the runner mirrors that same raw PTY byte stream through
  a private authenticated local bridge into a fresh owned native terminal host,
  whose real window supplies screenshots/video. The bridge bootstrap never
  contains the target argv/cwd/env. Native-terminal provider discovery is
  environment/capability based, not project based: macOS prefers installed
  iTerm2 then Terminal.app; Windows uses Windows Terminal; Linux prefers kitty,
  then Alacritty, GNOME Terminal, Konsole, and xterm. The provider is usable for
  visual QA only when the corresponding desktop driver can also correlate and
  capture its real window.
  Selection is based on required capabilities/evidence, never a repository-
  specific heuristic. If pixel fidelity is required but native-terminal control
  is unavailable, the result is `BLOCKED`; the runner does not silently
  substitute a headless replay.
- The target in either TUI presentation may use its normal explicit
  project/session arguments to open deterministic state before assertions.
  Non-interactive stdout from another CLI path is not TUI verification.
  Automated input in both presentations goes to the same owned PTY, and native-
  terminal host stdin/protocol responses are bridged back to it; flows wait for
  expected text or a stable frame after `sendText`/`sendKeys` before asserting
  or capturing the resulting state.
  PTY-only `sendPaste` wraps printable input in bracketed-paste delimiters for
  targets that enabled it (otherwise the action fails safely), preventing a
  subsequent Enter from being swallowed as an unbracketed multiline paste when
  PTY writes merge. Screen text includes
  prompt/editor echo; assert a response marker absent from the submitted input.
- Native desktop verification is selected from `target.application`. macOS uses
  the bundled Accessibility/CGWindow/ScreenCaptureKit helper, Windows uses the
  bundled PowerShell/.NET UI Automation helper, and Linux uses the bundled
  Python AT-SPI helper when its runtime dependencies and graphical accessibility
  bus are available. Required runtime components are capability-probed; missing
  dependencies/permissions or unsupported platforms return `BLOCKED`. The agent
  must not install UI automation dependencies, change OS privacy/accessibility
  permissions, disable sandboxing, or operate unrelated user windows.
- In source/development runs, the macOS helper lives at the permanent OS-user path
  `~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility`, outside
  every project's `.pi` and outside isolated app HOME overrides. Projects share
  the same installation and cross-project build lock. Registry Clean and scratch
  TTL cleanup do not remove it. A matching private legacy project helper can be
  copied, signature-verified and installed unchanged; the old helper is not
  deleted or used through a symlink. Repeated probes reuse a verified executable.
  Source changes build
  privately and replace it atomically; its code-signing identifier is fixed to
  `org.pix.ui-qa.macos-accessibility` rather than the staging filename. By
  default the helper is ad-hoc signed: unchanged builds retain their identity,
  but a source update changes its code-hash-based designated requirement and
  may require a fresh user approval. Set `PI_UI_QA_MACOS_CODESIGN_IDENTITY` to
  an available keychain signing certificate to use a certificate-based
  designated requirement that survives updates. Do not assume Pix Desktop's
  own Accessibility/Screen Recording approvals transfer to this helper; check
  `doctor` in the active login session and grant permissions in System Settings
  for the helper if needed. The runner never grants TCC permissions itself.
  On an explicit user request, the parent/user may invoke
  `"<exact helper path>" doctor --prompt` to request both permissions. Requesting
  is not approval: a prompt may return `missing` before the user responds, and
  an already-denied request may require manual enabling in System Settings.
  Recheck with plain `doctor` in a fresh process after approval. No `tccutil`
  reset or TCC database edit is part of this workflow. Moving/re-signing the
  helper may require renewed approval even though the global path is durable.
- Installed macOS releases (portable TUI and Desktop) instead use the executable
  at `helpers/macos-accessibility` in their release payload. It is built during
  release preparation, signed with the release Apple signing identity and the
  fixed helper identifier, and signature-checked before execution. A missing
  or invalid packaged helper blocks QA rather than invoking `swiftc` in the
  user's project. Certificate signing can keep the helper's TCC identity across
  updates; ad-hoc signing remains a code-hash identity that may need reapproval.
- PTY-presentation runs automatically retain a bounded asciicast v2 replay in
  `artifacts.videos`. It is generated from timestamped PTY output and resize
  events, capped at 1 MiB, and is explicitly terminal-state replay rather than
  pixel evidence. Top-level `recordWindowVideo` is supported only as a boolean
  for desktop and native-terminal targets. Setting it to `false` skips the
  native window recorder before its startup wait or process creation and reports
  `windowVideo` as `disabled`; omission or `true` keeps best-effort recording.
  This opt-out does not change reported host capabilities, PTY diagnostic
  asciicast, or browser video. Malformed values and unsupported targets fail
  before probing. Native-terminal presentation retains real-window
  screenshots regardless of this option and, when recording is enabled and
  exact-window capture is available, a bounded MP4 from
  the owned native terminal host; its asciicast/headless captures remain
  diagnostic-only and are never promoted as proof of colors/glyphs/window
  geometry.
- When macOS 12.3+ ScreenCaptureKit and Screen Recording permission are
  available, desktop runs automatically retain a silent H.264 MP4 of only the
  correlated application window. Independent-window capture scales to fill the
  Retina encoder surface so the application occupies the complete video frame
  rather than a top-left subset with unused canvas. Recording is capped at 30
  seconds, has no display/region fallback, and is best-effort: an unavailable
  video is reported as a structured observation rather than an assertion
  failure.
- Windows UIA provides exact-window PNG capture through trusted Win32 APIs but
  does not yet advertise exact-window video. Linux AT-SPI provides PNG capture
  only when a supported screenshot producer (`gnome-screenshot` or `scrot`) is
  available; keyboard input is separately gated on a working `xdotool` in the
  current graphical session. Linux/Windows video remains an explicit missing
  capability rather than being synthesized from a different surface.
- Pass/fail requires a deterministic product-visible oracle such as terminal
  content/state, accessibility/app-driver control state, window/dialog state,
  visible copy, enabled/checked/value state, or another explicit application
  result. Screenshots explain the result but are not the sole oracle.
- When no safe deterministic PTY/GUI control path is available, the correct
  result is `BLOCKED`; static tests are not promoted to UI QA evidence.
- Cleanup is ownership-scoped: terminate only the PTY/session/app/driver process
  created by the run, never all processes with a matching application name.
  POSIX desktop launch contracts correlate and clean up the complete detached
  process group, so a package-manager wrapper may hand off to its GUI descendant
  without making that app unreachable or leaving it running. Windows uses the
  owned launcher PID as a process-tree root: UIA resolves the actual GUI
  descendant before interaction, and scoped cleanup uses `taskkill /T` against
  the owned launcher plus that correlated GUI root rather than an app name.
  On macOS, `wait-window --pgid` must keep the AppKit run loop servicing
  NSWorkspace registration while waiting for a late GUI descendant; a sleeping
  poll can retain an empty application list even after the AX window appears.

- For explicitly authorized synthetic key diagnostics only, macOS supports
  `target.application: { "fixture": "texteditBlank" }` plus exactly one
  `texteditSmoke` action. This fixed external-system-app exception does not relax
  generic launch validation. The fixed system bundle is opened through LaunchServices;
  a native supervisor retains the completion `NSRunningApplication` and compares
  instances with `isEqual`, never treating PID/group IDs as ownership. It refuses
  existing TextEdit and requires one blank focused untitled document. The separate
  `texteditBlankLifecycle` fixture requires zero smoke actions. Only bounded
  `snapshotAccessibility` may accompany the fixed seven-pair `ghbdtn ` smoke;
  screenshots/video and generic companions fail closed, without PID fallback.
  TextEdit is **never automatically closed or terminated**. Cleanup is separately
  `manualRequired`, `unknown`, `confirmed` (retained observed exit only), or `notNeeded`.
  A sent launch with missing/crashed supervisor still requires manual inspection.
  Only the directly spawned helper may be killed at its release cap. This establishes
  neither physical origin nor product counters; the [macOS guide](../../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/desktop-macos.md)
  describes remaining focus/autosave races, manual closing, and fail-closed handling.

## Unified capability-first runner contract

- One private JSONC flow under the owning agent's `ui-qa/flows/` declares
  exactly one browser URL, TUI command, or desktop application target. `probe`
  reports deterministic candidate capabilities and selects the matching backend;
  it also returns an authoritative `selection.guide = {backend, topic}` for the
  selected provider/presentation/platform detail when one exists. The child
  must load/reconcile that exact topic before `run`, which then executes the
  bounded flow. The child keeps the flow at mode `0600` on POSIX before either
  command, matching the runner's private-path checks.
- Browser execution uses only the Chrome Control driver. `target.browserDriver`,
  `target.devtools`, and top-level `environment` are not supported; the runner
  returns `BLOCKED` rather than selecting another driver.
- TUI execution launches only a bounded project-local/package-runtime contract
  through a real PTY, models ANSI/VT alternate-screen state with a headless
  terminal, and supports text, cursor, process, resize, stability, and capture
  assertions.
- Desktop execution is platform-specific behind one capability contract. macOS
  uses a bundled compiled Accessibility/CGWindow helper plus ScreenCaptureKit;
  Windows uses bundled PowerShell/.NET UI Automation plus Win32 window capture;
  Linux uses bundled Python AT-SPI plus runtime-probed screenshot/keyboard
  producers. Explicit selectors and owned launch roots must still resolve the
  actual GUI descendant. Unsupported platforms or missing required control
  capabilities return a structured `BLOCKED` result; unavailable best-effort
  video is reported without replacing deterministic assertions.
- Results normalize selection rationale, assertions, observations, and typed
  artifact groups across all backends. `BLOCKED` additionally normalizes a
  parent-facing `blockedHandoff` containing the selected backend/platform
  driver, missing capabilities, concrete reason, remediation string,
  `manualActionRequired: true`, and
  `automaticRemediationAttempted: false`. This handoff is the installation/
  permission/platform-repair reference for the parent; the QA child relays it
  and never performs those environment changes itself. Every runner/app/helper
  process has a bounded deadline and cleanup is limited to processes launched by
  that run.

## Browser backend execution contract

- A model-authored QA flow is declarative JSONC, not executable JavaScript. The
  flow never receives a browser handle, protocol object, arbitrary JavaScript
  evaluator, or credential values.
- The `chrome-control` driver implements `goto`, `reload`, `click`, `fill`,
  `waitFor`, `assertVisible`, `assertHidden`, `assertText`, `assertValue`,
  `assertCount`, `assertURL`, and `screenshot`. Locators are `testId` or `css`
  only. `fill` takes a non-sensitive string; password and file inputs are not
  supported. Clicks and fills use synthetic DOM events, not trusted native input.
- Not supported: headless execution, viewport or environment overrides, other
  tabs, frame/popup flows, downloads, DevTools diagnostics, video, traces,
  `target.browserDriver`, and `target.devtools`. A request for one returns
  `BLOCKED`; it is never weakened or delegated to another driver.
- State checks retry briefly within the runner deadline and the optional
  top-level `timeoutMs`. `screenshot` is a Chrome window PNG; the driver may
  briefly select the QA tab and attempts to restore the previous tab.
- Success requires deterministic assertions. Screenshots are supporting evidence.

## Reliability and shutdown contract

- The built-in `ui-qa` profile has a 300-second wall-clock budget unless
  the caller explicitly supplies a task or spawn timeout. This bounds model
  stalls as well as browser work.
- The trusted runner has its own bounded lifecycle. Browser launch, context
  setup, auth, flow execution, evidence finalization, and browser shutdown must
  not wait forever; a timeout reports the last started stage without exposing
  flow contents or credentials.
- The launcher always writes a small sanitized `progress.jsonl` journal in the
  agent directory. It records lifecycle/RPC event types and tool names, but not
  prompts, tool arguments, tool results, model text, or secrets. The browser
  runner writes similarly sanitized stage entries under its private workspace.
- On POSIX, newly launched agents own a process group. Settled, timed-out, and
  explicitly stopped agents signal that group rather than only the Pi process;
  timeout/settled shutdown escalates to `SIGKILL` after its grace period. On
  Windows the existing recursive `taskkill /T /F` behavior remains in force.
- Process-tree cleanup is scoped to a launcher-created process-group marker so
  an old or externally-created PID is never treated as an owned process group.
  User browser sessions outside that group must not be signalled.

## Acceptance criteria

1. `ui-qa` resolves to the intended model/fallback and its inline Markdown
   workflow, has no built-in role alias, and its isolated child process can
   register the configured model provider.
2. Every child spawn contains `--no-skills` but no `--skill`. The QA child
   receives the thin common contract plus guide-routing workflow in its initial
   prompt, loads exactly one base backend guide and only its routed detail topic
   through `PI_UI_QA_RUNNER guide`, treats `selection.guide` as authoritative
   before `run`, and runs from an unrelated project directory.
   Ordinary profiles are equally skill-free and do not receive QA-only
   environment paths.
3. Runner error output is redacted, and model-authored input cannot execute code
   in the runner process.
4. Chrome Control tests cover the owned-tab lifecycle: a redirected page is refused
   while the owned tab still closes, a lost interaction result is not repeated,
   cleanup failure is not reported as success, page programs use fixed results,
   and blank-marker recovery is limited to the pinned instance
   (`test/async-subagents/chrome-control.test.ts`).
5. Native/TUI evidence, including bounded PTY replay, native-terminal real-
   window screenshots/video when requested and available, and exact-window
   desktop video when available, lives under the owning agent's `ui-qa/`
   workspace. Browser flows and verified screenshots use the same private
   `ui-qa/flows/` and `ui-qa/evidence/` layout.
6. The browser backend produces no video or trace evidence; the synthetic-DOM and origin-check limits are in `guides/browser.md`.
7. Completed test runs report clickable screenshot links whenever screenshots exist;
   browser runs produce no video or trace links.
8. Timeout tests identify the last runner stage, launcher progress remains
   available when full RPC logging is disabled, and process-tree tests prove a
   descendant is terminated without signalling unrelated processes.
9. TUI/native instructions require a real PTY/app driver, deterministic
   product-visible oracles, scoped cleanup, and a `BLOCKED` result when safe
   automation is unavailable rather than substituting source/unit tests.
   Pixel-sensitive TUI tasks select native-terminal presentation by capability
   need rather than app identity; the target still runs in one owned PTY while
   a private bridge mirrors its bytes into an owned real terminal window.
10. Suite tests/typecheck, host checks, and suite sync pass.
11. Unified runner tests cover deterministic backend/presentation selection,
    real PTY screen state and scoped cleanup, native-terminal bridge bootstrap
    isolation, Windows/Linux native-host launch contracts, unsafe launch/path
    rejection, timeout bounds, platform blockers, and the trusted Windows UIA/
    Linux AT-SPI helper protocols. The opt-in macOS E2E launches a real AppKit
    window, semantically activates its control, and retains accessibility,
    screenshot, and automatic exact-window video evidence. Windows/Linux
    real-host smokes are required before claiming those platform integrations
    runtime-verified; macOS tests do not substitute for that evidence. The
    opt-in macOS process-group regression starts `wait-window` before a wrapper
    creates its GUI descendant, then verifies the returned PID belongs to the
    wrapper's group without requiring Screen Recording permission.

## Browser regression coverage

Browser behavior is covered by the deterministic Chrome Control tests in
`test/async-subagents/chrome-control.test.ts` and by the unified runner tests.
The repository has no real-browser E2E or `test:browser-qa-e2e` script.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"25d9cfbd253e4d8c3c06a1698e104cf8c0800a950756ea20fca65c94649ef643","checkedAt":"2026-10-31T00:28:06.493Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":46,"reportLanguage":"ru"} -->
