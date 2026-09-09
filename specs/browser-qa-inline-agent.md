# Self-contained browser QA agent instructions

## Type

As-is

## Lifecycle

Active implemented contract.

## Purpose

Use the same one-agent/one-Markdown definition for browser QA as for other
built-in and project-local roles. Remove the mandatory private QA skill without
changing the browser runner's credential or evidence protections.

## Definition and resources

- `external/pi-tools-suite/src/async-subagents/agents/browser-qa.md` holds the
  existing model, fallback, thinking, tools, and timeout frontmatter plus the
  complete workflow, flow contract, auth-scaffold guidance, and detailed
  scenario-design instructions formerly read from separate skill documents.
- The shared loader turns the body into `promptAppend`; only the short
  `description` reaches parent/router catalogs. No QA-specific prompt injection
  or extra skill read is required.
- Runner, vendor dependency/license, and JSONC examples move into the sibling
  `agents/browser-qa/` resource directory. Runner/vendor bytes are unchanged.
  JSONC examples are optional reference assets, not additional instructions.
- The old skill and separate design/scaffold documents are removed. Ordinary
  `.pi/agents` discovery remains non-recursive, so assets cannot become roles.

## Runtime behavior

The default QA profile resolves with no `isolatedSkills`. `spawnAgent` still
forces `--no-skills` for `browser-qa`, independently of whether any skills were
configured. Skill flags in forwarded CLI arguments remain filtered. Optional
profile `isolatedSkills` load explicitly, without a mandatory QA skill.
Other profiles keep their existing skill-discovery behavior.

The launcher sets the non-secret `PI_BROWSER_QA_RUNNER` to the absolute runner
path resolved relative to the installed package. QA instructions invoke
`node "$PI_BROWSER_QA_RUNNER"`; they do not assume a package-relative cwd.
Inherited runner/workspace paths are replaced for QA children and stripped
from other children. `PI_SUBAGENT_AGENT_DIR` and private workspace lifecycle
remain unchanged.

Profile merge semantics are unchanged: model-only overrides retain the body,
task prompt additions follow it, and a task `promptOverride` still receives
the profile's appended instructions. Explicit profile `promptAppend` can
replace the inherited body. Prompts are guidance, not immutable enforcement;
origin/auth/path/evidence checks continue to be implemented by the runner.

## Preserved contracts

- Only the trusted runner owns browser execution and credential handling.
- The actual requested target is tested; static checks or invented mock pages
  cannot substitute for browser QA.
- Public QA does not require credentials or create an auth file.
- Auth scaffolding uses discovered public selectors and secret placeholders;
  agents never read/edit the credential file. Auth paths stay private and
  fail closed on invalid permissions, symlinks, or non-empty replacement.
- Deterministic assertions, screenshot inspection, redacted statuses, artifact
  links, bounded execution, and agent-local cleanup are preserved.

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/browser-qa.md`
- `external/pi-tools-suite/src/async-subagents/core/agents-dir.ts`
- `external/pi-tools-suite/src/async-subagents/core/config.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/core/browser-qa.ts`
- `external/pi-tools-suite/test/async-subagents/core.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`

## Verification

Core regression tests cover body inheritance, unchanged role settings, short
parent catalogs, prompt delivery over child RPC without a skill, forced skill
isolation, optional skills, ordinary-child env cleanup, and invoking the actual
runner's non-browser `profiles` command from a temporary project with spaces.
Runner tests use the relocated assets; packaging smoke checks require the
agent, runner, dependency/license, and examples at their new paths.

Live QA/model behavior must be verified separately from deterministic tests;
moving instructions into the initial prompt changes their presentation.
