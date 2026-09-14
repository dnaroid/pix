# Self-contained UI QA agent instructions

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

Use the same one-agent/one-Markdown definition for real UI QA as for other
built-in and project-local roles. The canonical `ui-qa` role covers browser,
terminal/TUI, and native desktop verification while preserving the browser
runner's credential and evidence protections.

## Definition and resources

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md` holds the model,
  fallback, thinking, tools, and timeout frontmatter plus a thin common
  contract: real-target and `BLOCKED` invariants, deterministic-assertion
  oracle, bounded execution, owned cleanup, private evidence with clickable
  artifact links, credential opacity for `.pi/qa_auth.jsonc`, and the minimal
  guide/probe/run invocation syntax.
- Backend-specific instructions are progressive-disclosure guides under
  `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
  (`browser.md`, `tui.md`, `desktop.md`, plus `browser-auth.md`). The child
  must load exactly the one matching guide before any UI action through the
  read-only runner command `node "$PI_UI_QA_RUNNER" guide --backend
  browser|tui|desktop`; `--topic auth` is available only for browser and only
  when authentication is actually required. The command selects files from a
  fixed bundled allowlist (no model-composed paths or traversal), rejects
  unknown backends/topics/options and extra arguments, bounds guide size, and
  prints only the requested document. Guides are not discoverable agent roles.
- The shared loader turns the thin body into `promptAppend`; only the short
  `description` reaches parent/router catalogs. No QA-specific prompt injection
  or extra skill read is required.
- The capability-first runner and its browser/TUI/desktop backends live under
  `agents/ui-qa/`. The trusted browser runner, vendor dependency/license, and
  legacy JSONC assets are grouped under `agents/ui-qa/browser/`. Vendor bytes
  stay unchanged; both runners accept the canonical `ui-qa` owner type as well
  as the legacy alias. JSONC examples are optional reference assets, not
  additional instructions.
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
and typed artifact links. TUI runs use a real PTY plus ANSI/VT screen model and
automatically retain a bounded asciicast v2 replay. macOS desktop runs use the
bundled Accessibility/CGWindow helper and, when ScreenCaptureKit plus Screen
Recording permission are available, automatically retain a silent, bounded
video of only the correlated application window. Video remains best-effort
evidence and never replaces deterministic assertions. Launch contracts, private
paths, deadlines, and owned-process cleanup are enforced by the runner rather
than by model instructions alone.

POSIX desktop launch contracts are correlated and cleaned up by their owned
detached process group, not only by the launcher PID. This lets package-manager
wrappers hand off to the real GUI descendant without making that descendant
invisible to accessibility automation or leaving it behind after QA. Windows
retains PID-based selection until its native driver provides an equivalent
group primitive. Launch environments allow bounded `PI_UI_QA_*` bootstrap
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

- Only the trusted runner owns browser execution and credential handling.
- Native/TUI QA exercises the actual shipping UI through a PTY or deterministic
  app/platform driver; unavailable safe automation produces `BLOCKED` rather
  than a static-check substitute.
- The actual requested target is tested; static checks or invented mock pages
  cannot substitute for requested UI QA.
- Public QA does not require credentials or create an auth file.
- Auth scaffolding uses discovered public selectors and secret placeholders;
  agents never read/edit the credential file. Auth paths stay private and
  fail closed on invalid permissions, symlinks, or non-empty replacement.
- Deterministic assertions, screenshot inspection, automatic bounded video
  evidence, redacted statuses, artifact links, bounded execution, and
  agent-local cleanup are preserved.

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift`
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
`guide` command (exact document output, explicit-only auth topic, strict
rejection of unknown backends/topics/options/extra args/traversal, and
operation from arbitrary cwd including paths with spaces), real PTY behavior
and bounded asciicast evidence, unsafe launch and path rejection, timeout
bounds, platform blockers, and an opt-in real macOS AppKit accessibility flow
with automatic exact-window video. Browser runner tests continue covering the
trusted credential-owning backend.

Live QA/model behavior must be verified separately from deterministic tests;
loading instructions through a second `guide` step changes their presentation.
