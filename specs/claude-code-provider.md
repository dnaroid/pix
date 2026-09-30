---
kind: spec
status: active
---

# Local Claude Code provider

## Behavior

The maintained `claude-code-provider` module of pi-tools-suite owns the Claude
Code adapter. Provider `pi-claude-code-provider`, API
`pi-claude-code-provider-headless`, model aliases and `PI_CLAUDE_CODE_PROVIDER_*`
configuration remain compatible with upstream 0.5.0. Authentication remains
Claude Code's subscription login; migration never reads or copies credentials.
Origin, license, local differences and update procedure live in the module's
`UPSTREAM.md`. The imported installed source already contained Pix patches;
it is not represented as pristine upstream.

The suite catalog enables the module by default. Pix TUI autoloads the personal
suite (its bootstrap installs/links bundled source); Desktop/ACP prefers that
installed personal suite and otherwise uses the
bundled copy. Run the suite sync after updating source. Isolated async children
load only the suite-relative standalone module entrypoint, not the whole suite
and not a user/project npm package. Existing owned-launch, tool-guard and
provider-web-search policies continue to apply.

Before enabling the new suite, `scripts/migrate-claude-provider.mjs` changes
only legacy provider package declarations to `extensions: []` and removes
explicit legacy extension paths. It preserves package files, model selections,
unrelated settings and other resource filters. It is idempotent and supports
`--check`, `--agent-dir`, and explicit `--project-settings`. Personal suite sync
refuses unmigrated personal settings. No npm uninstall is performed. Restart
all hosts after migration/sync; an already running session keeps its loaded code.

## Constraints and failure cases

Disable legacy declarations in every settings scope you use (including trusted
project overrides) and remove old explicit `-e` launch arguments. A post-load
`extensionsOverride` cannot prevent duplicate provider factories. Loading the
legacy package alongside the local module is unsupported. The migration does
not discover arbitrary custom launch scripts or inspect credential/auth files.
Invalid settings, symlinks and concurrent migration locks fail closed. If killed
while holding a lock, confirm its recorded PID is dead before removing it.

Image count has no local default cap, but byte/content/transcript guards remain
in force; see [image count](claude-image-count.md). Bounded image-read recovery
preserves private-transport, process termination, cancellation, timeout,
cleanup and accounting guarantees; see [recovery](claude-image-read-recovery.md).
No remote-service acceptance claim follows from offline tests. Paid Claude
requests require separate consent; local fixtures do not exercise the service.

## Implementation

- `external/pi-tools-suite/src/claude-code-provider/`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/async-subagents/core/provider-extensions.ts`
- `scripts/migrate-claude-provider.mjs`
- `scripts/sync-pi-tools-suite.mjs`
- `src/app/runtime.ts`
- `acp/src/acp/draft-model-runtime.ts`

## Tests

- `external/pi-tools-suite/test/claude-code-provider/`
- `external/pi-tools-suite/test/async-subagents/provider-extensions.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-offline.test.ts`
- `tests/claude-provider-migration.test.ts`
- `tests/claude-provider-registration.test.ts`

## Verification

Run the suite provider, configuration, search-policy and async-child offline
tests, the source typecheck, root migration tests, and suite sync check. Use the
fake CLI and isolated HOME/agent directory for registration/lifecycle probes.
Real Desktop/TUI QA belongs to `ui-qa`, not static test evidence.
