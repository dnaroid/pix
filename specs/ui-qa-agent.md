# Self-contained UI QA agent instructions

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

Use the same one-agent/one-Markdown definition for real UI QA as for other
built-in and project-local roles. The canonical `ui-qa` role covers browser,
terminal/TUI, and native desktop verification while preserving the browser
providers' credential, isolation, evidence, and cleanup protections.

## Definition and resources

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md` holds the model,
  fallback, thinking, tools, and timeout frontmatter plus a thin common
  contract: real-target and `BLOCKED` invariants, deterministic-assertion
  oracle, bounded execution, owned cleanup, private evidence, and the minimal
  backend-guide/probe/run invocation syntax. It deliberately contains no
  browser-provider, terminal-presentation, desktop-platform, or credential
  implementation instructions.
- Backend-specific instructions are progressive-disclosure guides under
  `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
  (`browser.md`, `tui.md`, `desktop.md`) plus backend-scoped detail topics:
  browser `playwright`, `chrome-devtools`, and `auth`; TUI `pty` and
  `native-terminal`; desktop `macos-accessibility`, `windows-uia`, and
  `linux-at-spi`. The child loads exactly one base guide through the
  read-only runner command `node "$PI_UI_QA_RUNNER" guide --backend
  browser|tui|desktop`, then only the detail topic required by that base
  router. The command selects files from a fixed backend-scoped bundled
  allowlist (no model-composed paths or traversal), rejects cross-backend or
  unknown topics/options/extra arguments, bounds guide size, and prints only
  the requested document. Guides are not discoverable agent roles.
- The shared loader turns the thin body into `promptAppend`; only the short
  `description` reaches parent/router catalogs. No QA-specific prompt injection
  or extra skill read is required.
- The capability-first runner and its browser/TUI/desktop backends live under
  `agents/ui-qa/`. The trusted Playwright browser runner, vendor
  dependency/license, and legacy JSONC assets are grouped under
  `agents/ui-qa/browser/`; the Chrome DevTools adapter lives under
  `agents/ui-qa/drivers/` and probes the external `chrome-devtools` CLI rather
  than loading a project skill. Vendor bytes stay unchanged; both runners
  accept the canonical `ui-qa` owner type as well as the legacy alias. JSONC
  examples are optional reference assets, not additional instructions.
- The old skill and separate design/scaffold documents are removed. Ordinary
  `.pi/agents` discovery remains non-recursive, so assets cannot become roles.

## Runtime behavior

All async sub-agent children are self-contained: `spawnAgent` always forces
`--no-skills` and strips `--skill` / `--skill=...` flags from forwarded CLI
arguments. `isolatedSkills` is no longer a supported profile field, so UI QA has
no special skill-loading path and cannot receive optional injected skills. The
launcher also appends `--models <effective-model>` after forwarded arguments,
preventing persisted model patterns from resolving unrelated providers in the
isolated child.

Explicit legacy `browser-qa` task names normalize to `ui-qa`. A project-local
`browser-qa.md` override is migrated to the canonical role when no `ui-qa.md`
override is present, preserving model/tool/thinking customization across the
rename.

The launcher sets non-secret `PI_UI_QA_RUNNER` and `PI_BROWSER_QA_RUNNER` paths
resolved relative to the installed package. QA instructions invoke the unified
runner for the read-only `guide` loader, capability probe, and browser/TUI/desktop
execution; they invoke the trusted browser runner directly only for auth profile
discovery/scaffolding as the browser-auth guide instructs.
Inherited runner/workspace paths are replaced for QA children and stripped from
other children. Unified flows plus native/TUI evidence use the private
agent-local `ui-qa/` workspace; the trusted browser backend retains its
historical `browser-qa/` workspace.
Model-authored flows are credential-free but still use mode `0600` on POSIX so
the existing runner path/privacy validation succeeds without weakening it.

The unified runner selects exactly one backend from the flow target, reports
candidate capabilities and rationale, and normalizes assertions, observations,
typed artifact links. Every probe/run selection also exposes an authoritative
`selection.guide = {backend, topic}` when a supported detail route exists. The
child must reconcile its loaded detail guide with that value before `run`; this
keeps provider/presentation/platform routing capability-driven without putting
those decisions in the common role body. `BLOCKED` results additionally carry
a normalized
`blockedHandoff`: selected backend/platform driver, missing capabilities,
reason, remediation, `manualActionRequired: true`, and
`automaticRemediationAttempted: false`. This gives the parent agent a stable
environment-repair/install/permission handoff without granting the QA child
permission to modify the host. TUI runs use a real PTY plus ANSI/VT screen model
and automatically retain a bounded asciicast v2 replay. Desktop control is
platform-specific behind the same runner contract: macOS uses bundled
Accessibility/CGWindow/ScreenCaptureKit, Windows uses bundled PowerShell/.NET UI
Automation with Win32 exact-window PNG capture, and Linux uses bundled Python
AT-SPI with runtime-probed screenshot/keyboard producers. macOS exact-window
video scales to fill the Retina encoder surface; Windows/Linux currently report
`windowVideo` as missing rather than fabricating video evidence from another
surface. Evidence never replaces deterministic assertions. Launch contracts,
private
paths, deadlines, and owned-process cleanup are enforced by the runner rather
than by model instructions alone.

Browser provider selection happens inside the browser backend and is likewise
capability-driven. `target.browserDriver` accepts `auto`, `playwright`, or
`chrome-devtools`. `auto` keeps ordinary E2E and every trusted auth profile on
Playwright; DevTools-only accessibility-tree, console/network, Lighthouse,
performance-trace, or heap-summary actions select Chrome DevTools. Explicit
`target.devtools` startup/attach options also select Chrome DevTools in `auto`
mode. The selection never depends on repository or application identity.

The Chrome DevTools provider requires `chrome-devtools-mcp >= 1.9.0`, creates a
random per-run daemon session, and stops only that session. It starts an
isolated Chrome/profile by default; an existing Chrome may be attached only by
an exact credential-free local loopback `browserUrl`. Even then, a task-owned
isolated page/context is the default, while `reuseExistingBrowserSession: true`
is reserved for a parent/user request that explicitly requires the existing
authenticated session. The runner closes only its own page and never closes or
stops externally owned Chrome/tabs.

DevTools execution disables JavaScript evaluation, extensions/PWA/experimental
categories, usage statistics, and CrUX lookup; enables network-header
redaction/page-id routing; restricts writes to the evidence directory; and
passes exact target/allowed origins into the DevTools network allowlist. Raw
network headers and response bodies are never published. Trusted
`.pi/qa_auth.jsonc` profiles remain Playwright-only, and the QA child never
installs/upgrades the CLI or moves credentials into DevTools arguments/profile
state. Supported DevTools flow actions are the common navigation/basic
interaction/text/URL/screenshot subset plus `snapshotAccessibility`,
`assertNoConsoleErrors`, `assertConsole`, `assertNetworkRequest`, `lighthouse`,
`performanceTrace`, and `heapSummary`. DevTools locators resolve one UID from
the latest AX snapshot using `{role,name?,exact?}` or `{text,exact?}`. Raw heap
snapshots and raw performance traces are deleted after retaining bounded
sanitized summaries. Top-level
deterministic `environment` remains Playwright-only; DevTools blocks it rather
than approximating locale/timezone/reduced-motion semantics.

POSIX desktop launch contracts are correlated and cleaned up by their owned
detached process group, not only by the launcher PID. This lets package-manager
wrappers hand off to the real GUI descendant without making that descendant
invisible to accessibility automation or leaving it behind after QA. Windows
uses the owned launcher PID as a process-tree root: UI Automation resolves the
actual GUI descendant before interaction, and cleanup stays scoped to the
launcher plus that correlated GUI root. Launch environments allow bounded
`PI_UI_QA_*` bootstrap
variables in addition to the generic environment allowlist; the runner always
supplies `PI_UI_QA=1`. TUI targets may use their ordinary explicit project and
session arguments to open deterministic state inside the real PTY before
assertions. Because PTY input and application rendering are asynchronous, TUI
flows wait for the expected text or a stable frame after input before asserting
the resulting screen.
Repeated unnamed Desktop evidence steps receive collision-free filenames based
on their action and step index, while explicit names remain available for stable
human-readable labels.

Profile merge semantics are unchanged: model-only overrides retain the body,
task prompt additions follow it, and a task `promptOverride` still receives
the profile's appended instructions. Explicit profile `promptAppend` can
replace the inherited body. Prompts are guidance, not immutable enforcement;
origin/auth/path/evidence checks continue to be implemented by the runner.

## Preserved contracts

- Only the unified/trusted runners own browser execution and credential
  handling; the QA child never invokes Playwright or `chrome-devtools`
  directly for probe/run.
- Native/TUI QA exercises the actual shipping UI through a deterministic
  presentation selected by required capabilities, never by project identity.
  New role-authored flows explicitly use PTY/headless ANSI presentation for
  line-oriented/plain-terminal or protocol-focused targets, and use native-
  terminal presentation by default for structured/full-screen TUIs. The runner
  keeps omitted presentation as PTY only for backward compatibility. Native-
  terminal still controls one
  runner-owned PTY target and uses that same PTY for deterministic text/cursor/
  process oracles, but mirrors its exact byte stream through a private trusted
  bridge into a fresh owned terminal window whose real pixels are captured. No
  target argv/cwd/env is embedded into that terminal bootstrap. Native host
  providers are environment-selected, never project-selected: macOS prefers
  installed iTerm2 then Terminal.app; Windows uses Windows Terminal; Linux
  prefers kitty, then Alacritty, GNOME Terminal, Konsole, and xterm. Availability
  additionally requires the platform desktop driver to correlate/capture the
  real terminal window. If exact visual terminal evidence is required and that
  capability is unavailable, the result is `BLOCKED`; a headless replay cannot
  substitute for pixel evidence.
- The actual requested target is tested; static checks or invented mock pages
  cannot substitute for requested UI QA.
- Public QA does not require credentials or create an auth file.
- Auth scaffolding uses discovered public selectors and secret placeholders;
  agents never read/edit the credential file. Auth paths stay private and
  fail closed on invalid permissions, symlinks, or non-empty replacement.
- Deterministic assertions, screenshot inspection, automatic bounded video
  evidence, redacted statuses, artifact links, bounded execution, and
  agent-local cleanup are preserved.
- A blocked preflight/run always exposes the parent-ready `blockedHandoff` and a
  non-empty remediation string. The QA child relays those fields and stops; it
  does not install automation dependencies, grant OS permissions, or invent a
  different fallback surface.

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/chrome-devtools/chrome-devtools-provider.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/native-terminal-host.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/bridge-client.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/windows/windows-uia.ps1`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/linux/linux-atspi.py`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/core/browser-qa.ts`
- `external/pi-tools-suite/test/async-subagents/core.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-desktop.e2e.test.ts`

## Verification

Core regression tests cover the thin body size and router contract, absence of
backend-specific sections from the start prompt, presence of every guide file
in the package/sync payload without new discoverable roles, body inheritance,
the legacy name migration, short parent catalogs, prompt delivery over child
RPC without skills, global child skill isolation and skill-flag stripping,
ordinary-child env cleanup, both UI-QA workspaces, and invoking both installed
runner paths from a temporary project with spaces.
Unified runner tests cover backend selection, the read-only allowlisted
`guide` command (exact base/detail document output, backend-scoped topic
isolation including explicit-only auth, strict rejection of unknown/cross-
backend topics/options/extra args/traversal, and operation from arbitrary cwd
including paths with spaces), authoritative `selection.guide` routing, real
PTY behavior
and bounded asciicast evidence, unsafe launch and path rejection, timeout
bounds, platform blockers, cross-platform native-terminal provider selection,
and static/protocol contracts for the bundled Windows UIA and Linux AT-SPI
helpers. An opt-in real macOS AppKit accessibility flow covers the currently
available host E2E with automatic exact-window video. Windows/Linux real-host
smokes remain platform-host verification rather than being inferred from tests
executed on macOS. Browser runner tests continue covering the trusted
credential-owning backend.

Live QA/model behavior must be verified separately from deterministic tests;
loading instructions through a second `guide` step changes their presentation.
