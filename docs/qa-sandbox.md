# Default Pix QA project

When testing Pix without a specified data project, use a fresh disposable copy
of [`fixtures/qa/pix-project`](../fixtures/qa/pix-project/README.md). This tests
the real Pix application with synthetic project data, not a mock application.
An explicit project/path/URL or a request for real-project data always wins;
never silently substitute this sandbox. Existing target-specific isolation and
authorization rules still apply. If an explicit target cannot safely be tested,
report the blocker rather than redirecting to a sandbox.

## Desktop

Before setup, explicitly read `.pi/skills/pix-desktop-qa/SKILL.md` from this
checkout; child skill discovery is disabled. Follow its watcher, isolated
profile, unified-runner, assertions and cleanup workflow.

```sh
npm run qa:desktop -- prepare
```

Preparation automatically seeds the template into its owned workspace under
`.pi/subagents/`. It returns `workspace`, `projectSeed` and `manifestPath`;
the manifest records the same fields. Launch through the normal QA runner.
For empty-project/onboarding checks use `prepare --empty-workspace` instead.
Do not seed this template over an explicitly requested real project.

## TUI / manual project setup

```sh
npm run qa:sandbox
```

The command creates a unique `.pi/artifacts/pix-qa-sandbox-*/workspace` and prints
its absolute path. Launch the real requested Pix TUI in that working directory
through the unified runner. It does not launch an app, install dependencies,
configure providers or modify an existing project. The sample project's
`npm test` needs only Node, with no install step.

## Scenario data and limits

The template contains editable source, deterministic sample tests, Markdown
with Cyrillic search anchors, synthetic JSON and an SVG attachment. It contains
no credentials, model settings, real sessions, tasks database or Git history.
Setup requires Git and initializes an empty local repository in each copy so
Git commands cannot discover the source checkout as their parent repository.
It ignores inherited Git overrides and global/system Git configuration during
initialization and uses no template hooks. There are no commits or remotes.
Create required tasks/conversations through Pix or seed known valid starting
fixtures in the owned workspace before launch. Never edit storage to simulate
the behavior being tested. Git-dependent scenarios may create synthetic commits
in the disposable repository; do not copy real history/remotes.

UI-only checks need no model credentials. Prompt-based checks still require
authorized credentials and the Desktop skill's minimal paid-traffic rules.
Report the actual project path, assertions, evidence and untested real-data
coverage. A sandbox pass is not proof of real-project authentication, history,
restart/persistence or data migration. Scratch copies may be removed by Clean
or background TTL cleanup; export anything that must be retained.
