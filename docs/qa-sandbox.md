# Default Pix QA project

When testing Pix without a specified data project or a configured permanent
Desktop QA project, use a fresh disposable copy
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

Without local settings, preparation automatically seeds the template into its
owned workspace under `.pi/subagents/`. It returns `workspace`, `projectSeed` and `manifestPath`;
the manifest records the same fields. Launch through the normal QA runner.
For empty-project/onboarding checks use `prepare --temporary --empty-workspace` instead.
Do not seed this template over an explicitly requested real project.

### Permanent native QA project

An optional checkout-local `.pi/qa-desktop.json` selects a permanent project:

```json
{
  "version": 1,
  "persistentProject": "/absolute/path/to/separate/qa-project"
}
```

Alternatively, pass `prepare --persistent-project /absolute/path/to/qa-project`.
The project must be canonical, not a symlink, and outside the source checkout
(not its parent either). Initialization creates a private `.pix-qa/profile`
with a stable UUID bound to that project and checkout. It never seeds or
overwrites project files, provider configuration, credentials or history.
Prepare project data separately before the first launch, then reuse it.
An incomplete, foreign or unsafe existing profile is rejected, not repaired.

Each run still pins a fresh owned application and stores its manifest/evidence
under `.pi/subagents/` (or an explicit `.pi/artifacts/` run). The permanent
project/profile do not fall under checkout scratch cleanup. Add `.pix-qa/` to
the QA project's `.gitignore`; never commit or export this private profile.
The project testing skill may record the user-approved local project path;
do not change universal agent roles to enforce this checkout-specific policy.

Persistent native QA requires macOS 14+ and a persistence-capable artifact.
All its windows use the profile UUID's isolated WebKit data store, not the
working Desktop's default store. Its localStorage/onboarding survives owned
QA relaunches. WebKit owns that store outside `.pix-qa/profile`; deleting the
profile folder is **not** a complete WebKit reset. No automatic store reset or
migration is provided. Agent configuration, credentials and test history remain
in the private profile. Keep the stable UUID to keep this identity.

Only one launch can own a profile; finish the owned launch before relaunching.
Locks are never automatically stolen. Forced termination does not prove state
was saved. Use `prepare --temporary` explicitly for fresh/disposable scenarios
or independent parallel profiles. It bypasses local permanent settings;
`--empty-workspace`, `--seed-config` and `--seed-api-keys` cannot be combined
with permanent mode. A permanent setup failure never silently falls back.

Crash recovery is a manual, explicitly authorized operation, not automatic QA
setup. First prove that no process owns the profile; if ownership is uncertain,
stop. A stale `launch.lock` may then be removed by its exact path, without
changing the profile UUID or other state. If initialization was interrupted
before committing `profile.json`, preserve the incomplete `.pix-qa` directory
in a private backup before explicitly reinitializing it. Never delete a valid
profile to unblock a launch: it contains authorization and history, and a new
UUID does not clean up the previous OS-owned WebKit store.

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
production restart/persistence or data migration. A permanent QA persistence
check covers only its own isolated store, not the working app or watcher's
Restart handoff. Scratch copies may be removed by Clean
or background TTL cleanup; export anything that must be retained.
