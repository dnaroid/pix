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
  fallback, thinking, tools, and timeout frontmatter plus backend selection,
  native/TUI guidance, the browser flow contract, auth-scaffold guidance, and
  detailed browser scenario-design instructions.
- The shared loader turns the body into `promptAppend`; only the short
  `description` reaches parent/router catalogs. No QA-specific prompt injection
  or extra skill read is required.
- The capability-first runner and its browser/TUI/desktop backends live under
  `agents/ui-qa/`. Browser vendor dependency/license and legacy JSONC assets
  remain in the sibling `agents/browser-qa/` resource directory. Vendor bytes
  stay unchanged; both runners accept the canonical `ui-qa` owner type as well
  as the legacy alias. JSONC examples are optional reference assets, not
  additional instructions.
- The old skill and separate design/scaffold documents are removed. Ordinary
  `.pi/agents` discovery remains non-recursive, so assets cannot become roles.

## Runtime behavior

The default QA profile resolves with no `isolatedSkills`. `spawnAgent` forces
`--no-skills` for `ui-qa` (and the compatibility `browser-qa` alias),
independently of whether any skills were configured. Skill flags in forwarded
CLI arguments remain filtered. Optional profile `isolatedSkills` load
explicitly, without a mandatory QA skill. Other profiles keep their existing
skill-discovery behavior.

Explicit legacy `browser-qa` task names normalize to `ui-qa`. A project-local
`browser-qa.md` override is migrated to the canonical role when no `ui-qa.md`
override is present, preserving model/tool/thinking customization across the
rename.

The launcher sets non-secret `PI_UI_QA_RUNNER` and `PI_BROWSER_QA_RUNNER` paths
resolved relative to the installed package. QA instructions invoke the unified
runner for capability probe and browser/TUI/desktop execution; they invoke the
trusted browser runner directly only for auth profile discovery/scaffolding.
Inherited runner/workspace paths are replaced for QA children and stripped from
other children. Unified flows plus native/TUI evidence use the private
agent-local `ui-qa/` workspace; the trusted browser backend retains its
historical `browser-qa/` workspace.

The unified runner selects exactly one backend from the flow target, reports
candidate capabilities and rationale, and normalizes assertions, observations,
and typed artifact links. TUI runs use a real PTY plus ANSI/VT screen model;
macOS desktop runs use the bundled Accessibility/CGWindow helper. Launch
contracts, private paths, deadlines, and owned-process cleanup are enforced by
the runner rather than by model instructions alone.

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
- Deterministic assertions, screenshot inspection, redacted statuses, artifact
  links, bounded execution, and agent-local cleanup are preserved.

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`
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

Core regression tests cover body inheritance, the legacy name migration, short
parent catalogs, prompt delivery over child RPC without a skill, forced skill
isolation, optional skills, ordinary-child env cleanup, both UI-QA workspaces,
and invoking both installed runner paths from a temporary project with spaces.
Unified runner tests cover backend selection, real PTY behavior, unsafe launch
and path rejection, timeout bounds, platform blockers, and an opt-in real macOS
AppKit accessibility flow. Browser runner tests continue covering the trusted
credential-owning backend.

Live QA/model behavior must be verified separately from deterministic tests;
moving instructions into the initial prompt changes their presentation.
