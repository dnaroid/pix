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

Claude Code is optional. When `claude` is absent from PATH and no nonblank
`PI_CLAUDE_CODE_PROVIDER_PATH` is configured, initialization quietly leaves the
provider, models and search tool unregistered: normal session startup has no
unavailable-provider notice. The doctor command remains available and reports
the missing executable when explicitly invoked. A nonblank explicit executable
path that is missing, or other preflight failures (including authentication or
capability errors), still produce the existing startup error. Install/configure
Claude and reload/restart to activate the provider; there is no background
installation or automatic reprobe.

Before enabling the suite, `scripts/migrate-claude-provider.mjs` changes
only legacy provider package declarations to `extensions: []` and removes
explicit legacy extension paths. It preserves package files, model selections,
unrelated settings and other resource filters. It is idempotent and supports
`--check`, `--agent-dir`, and explicit `--project-settings`. Sync to the default
personal suite location refuses unmigrated personal or current-project settings
(`.pi/settings.json` in the sync command's working directory), including in
`--check` mode. No npm uninstall is performed. Restart
all hosts after migration/sync; an already running session keeps its loaded code.

Provider availability and picker visibility are separate. If the doctor command
reports the models but `/model` does not show them, inspect the frontend's
`visibleModels` whitelist (see [model visibility](model-visibility-whitelist.md)).
An existing explicit whitelist does not automatically include the provider's
`pi-claude-code-provider/{sonnet,fable,opus,haiku}` refs. Enable the desired models
in the picker's management mode or explicitly add those refs to the corresponding
user config; migration itself preserves visibility preferences.

### Timeout diagnostics

Content-free request metrics and the doctor's last-request report record the
original finite caller `timeoutMs` (when supplied), configured total limit and
its environment/default source, shared request budget, effective launch total,
idle and MCP-ready limits, and whether this is an image-recovery attempt.
Total and idle timeout errors also include these budgets so persisted session
errors retain the evidence without enabling a metrics log. No prompt, tool
content, arbitrary environment values or paths are added. Existing deadline
selection and recovery-budget subtraction are unchanged. The optional
`PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` persists finalized per-attempt metrics;
diagnostics do not add a new always-on log or startup write.

### Native image transport

Images are delivered as native `image` blocks (`source.type: base64`,
`media_type`, `data`) in the CLI's stream-json user message on stdin, not as
generated `@file` references. This bypasses Claude Code's file-mention size
filter (256 KiB in CLI 2.1.283), which silently omitted larger attachments.
The provider preserves validated decoded bytes without recompression. All
images in the effective context, including user history, tool results and
payload-hook replacements, remain eligible; duplicates by bytes/MIME are sent
once in first-occurrence order. Each native image follows a text label whose
private path basename identifies the corresponding `image_attachment` records.
At signs in labels are escaped, as in transcript records, to prevent expansion.

Native blocks follow the text transcript and its cache breakpoint; image blocks
and labels carry no explicit breakpoint. The private image store/files remain
for stable correlation, path guards and bounded attachment-read recovery, not
for CLI file loading. Existing path restrictions, validation, count/byte metrics,
leases, cancellation, process-death and cleanup guarantees are unchanged.
`transcriptBytes` still measures text transcript bytes, not base64 wire bytes;
decoded image limits continue to bound the image payload separately.

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
Native input avoids the file-mention filter, not Claude Code or service image
count, dimension, request-size or preprocessing limits; no legacy @file fallback
is attempted if native input is rejected.

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
- `external/pi-tools-suite/test/claude-code-provider/native-images.test.ts`
- `external/pi-tools-suite/test/claude-code-provider/image-read-provider.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-extensions.test.ts`
- `external/pi-tools-suite/test/async-subagents/provider-offline.test.ts`
- `tests/claude-provider-migration.test.ts`
- `tests/claude-provider-registration.test.ts`

## Verification

Run the suite provider, configuration, search-policy and async-child offline
tests, the source typecheck, root migration tests, and suite sync check. Use the
fake CLI and isolated HOME/agent directory for registration/lifecycle probes.
Real Desktop/TUI QA belongs to `ui-qa`, not static test evidence.
The native-image regressions cover a valid PNG over 256 KiB through the real
provider stdin path into a fake CLI, byte/MIME preservation, deduplication,
role correlation, label escaping and image-bearing recovery/lifecycle behavior.
Response-observer rejection regressions cover both a still-live child requiring
forced cleanup and a child whose close is observed before rejection. Both must
publish only an error and finish private cleanup; the fixture must not race a
short natural-exit timer against Windows process-tree termination.
