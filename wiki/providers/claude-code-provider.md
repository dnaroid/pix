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

### Claude Code login, refresh and quota warnings

Provider settings live **only** in the user-level `~/.config/pi/pi-tools-suite.jsonc`, under `claudeCodeProvider`, shared by Pix Desktop/ACP and TUI. A workspace's project config cannot supply them. The only supported key is `showRateLimitWarnings` (schema `additionalProperties: false`):

```jsonc
"claudeCodeProvider": {
  "showRateLimitWarnings": true
}
```

The retired keys `accounts`, `autoRotate`, `selectedAccount` and `rotationDelaySeconds` are ignored by the provider loader, so an old file never disables the provider; Desktop schema validation flags them. There is no account rotation, profile selection or per-account cooldown.

Every request uses the single default Claude Code CLI login. `CLAUDE_CONFIG_DIR` is forwarded to Claude when it is set in the environment, and no OAuth token variable is forwarded. Pix never reads, copies, stores or displays login tokens.

**Login-refresh preflight.** Before each Claude launch, the provider reads only the `expiresAt` of the stored login: macOS Keychain item `Claude Code-credentials[-hash]`, otherwise `<config>/.credentials.json`. If the login expires within Claude's own five-minute refresh window, it runs one dedicated `claude -p /usage --no-session-persistence` (temporary cwd, 45 s timeout) so Claude refreshes it under its own cross-process lock. An expiry already known to be outside the window is cached per session, so ordinary requests read no credentials. Concurrent requests in one process share a single-flight refresh per executable; a caller's abort stops only that caller's wait. Refresh launches are spaced at least `LOGIN_REFRESH_RETRY_MS` (60 s) apart per process, so a failing refresh (for example a revoked login) does not add a Claude run to every request. Refresh failures never fail a request; they are reported as diagnostics `warn auth/login-refresh-failed`. `PI_CLAUDE_CODE_PROVIDER_LOGIN_REFRESH=off` disables the preflight (tests use it).

**Shutdown grace.** A supervised Claude process group receives SIGTERM and then SIGKILL after `CLAUDE_TERMINATION_GRACE_MS` (3000 ms, previously 500 ms). Claude can wait up to 2 s on exit to persist a rotated refresh token; an earlier kill could lose it and cause server-side revocation ("OAuth token revoked" across sessions).

**Quota warnings.** Desktop Settings → Tools Suite → Claude Code subscription has one control, **Claude quota warnings**, discoverable through settings search (quota and rate-limit terms). It sets `claudeCodeProvider.showRateLimitWarnings`, which defaults to `false`, and controls whether the provider displays notices for Claude's `allowed_warning` rate-limit events. The provider reads it during initialization, so reload/restart sessions to apply a change. Disabling it suppresses only `allowed_warning` UI notifications; structured quota telemetry and rejected-quota notifications/errors are unchanged.

The provider-specific `pi_claude_code_provider_web_search` tool is not registered or used; the suite's separate `web_search`/`web_fetch` tools are unchanged.

Claude Code is optional. When `claude` is absent from PATH and no nonblank
`PI_CLAUDE_CODE_PROVIDER_PATH` is configured, initialization quietly leaves the
provider, models and search tool unregistered: normal session startup has no
unavailable-provider notice. The doctor command remains available and reports
the missing executable when explicitly invoked. A nonblank explicit executable
path that is missing, or other preflight failures (including authentication or
capability errors), still produce the existing startup error. Install/configure
Claude and reload/restart to activate the provider; there is no background
installation or automatic reprobe.

An installed CLI whose auth status explicitly says `loggedIn: false` reports
that Claude Code is not logged in and asks the user to run `claude auth login`
with an eligible first-party subscription, then `/reload`. Claude's exit 1 for
this structured auth result is classified as `auth_required`, not an opaque
command failure. Other nonzero exits, malformed output and process failures
remain preflight errors; a nonzero exit never enables the provider. Auth status
payloads/identity fields are not copied into the login notice. The unavailable
notice is emitted only when the session is using this provider:
`session_start` checks `ctx.model.provider`, and `model_select` checks the
selected `event.model.provider`. Starts for other providers or with no model are
quiet and do not consume notice deduplication. When this provider is selected,
the notice is emitted once across consecutive session bindings with the same
session ID, including notifications from either event.

### Experimental historical thinking pruning

The serializer omits all historical thinking blocks from the transcript by
default, including those from the current tool loop. Signatures cannot be
replayed, so the text gives the model no resumable reasoning, and long loops
used to resend tens of kilobytes of it on each request.
`PI_CLAUDE_CODE_PROVIDER_REPLAY_THINKING=1` (or `true`) restores replay of the
summary text; values other than `1`, `true`, `0`, or `false` fail with
`replay_thinking_config`. Session files and the Desktop transcript keep all
thinking.

The suite-wide experimental `pruneHistoricalThinking` setting (module
`historical-thinking-prune`, see `wiki/context/historical-thinking-prune.md`)
removes earlier-turn thinking in Pi's `context` event, before this serializer
runs. For Claude Code it only matters when replay is enabled.

### Desktop sign-in recovery

Claude authentication error cards offer **Sign in to Claude**. This is an
explicit user action, not a background login or an automatic task retry. Only
host provider/extension error rows identifying Claude Code and expired OAuth,
failed authentication or a missing login qualify; unrelated provider errors,
quota warnings and ordinary transcript text do not.

Historical authentication error cards and their text remain in the transcript,
but the complete sign-in recovery block (login action,
Continue action and guidance) is shown only for the final transcript item when
no prompt is running. Starting a retry hides stale recovery controls without
removing the error; a later final authentication error offers recovery again.

The action opens Pix's existing Terminal workbench and runs `"${PI_CLAUDE_CODE_PROVIDER_PATH:-claude}" auth login --claudeai`. The command honors `PI_CLAUDE_CODE_PROVIDER_PATH` from the terminal environment, falling back to `claude`. Configuration is reread before launch so a changed path is used. Repeated clicks are ignored while that action is pending,
and stale configuration completions after unmount/session changes never launch
a terminal. Config/launch failures have visible retry feedback and sanitized
diagnostic reports. Terminal launch failures and a busy terminal propagate to
the caller instead of looking like a successful launch.

Claude CLI owns the browser flow and credential storage. Pix never reads,
copies or displays tokens, and opening the terminal is not proof of successful
authentication. The user completes the terminal/browser flow, returns to the
conversation and retries the request. A provider disabled by startup preflight
still needs a reload/restart after sign-in; recovery does not re-register it.

The first-run dialog's Claude Code row runs the same login command after its
own setup completes; see [desktop first-run bootstrap](../configuration/desktop-first-run-bootstrap.md).

Pix Desktop's ACP bridge delivers startup and background extension `warning`
and `error` notifications as visible system rows (`pix-system:` message ids),
without requiring an active prompt. Slash-command feedback still delivers all
levels; background informational notifications stay quiet. This is conversation
feedback, not an OS notification. Notices are live feedback, not persisted Pi
history.
ACP preserves warning/error severity in `pix-system:notification:warning:` and
`pix-system:notification:error:` ids. Desktop shows these as compact inline
cards with a Lucide warning icon, a severity-colored left border, and the
original notice text. Warning cards use the warning color and do not claim the
agent stopped. Extension errors are titled `Extension error`; only actual
`pix-system:error:` provider-failure rows say `Agent stopped with an error`.
Rate-limit rows already received from older ACP hosts also use warning cards.
Ordinary command feedback keeps its existing plain system-row presentation.
Desktop retains early startup rows when a draft becomes a real session, as
specified in [draft optimistic submit](../desktop/conversations/desktop-draft-optimistic-submit.md).

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
`visibleModels` whitelist (see [model visibility](../configuration/model-visibility-whitelist.md)).
An existing explicit whitelist does not automatically include the provider's
`pi-claude-code-provider/{sonnet,fable,opus,haiku}` refs. Enable the desired models
in the picker's management mode or explicitly add those refs to the corresponding
user config; migration itself preserves visibility preferences.

### Built-in plugin isolation

The shared launch settings for provider requests and the dormant web-search implementation
explicitly disable the built-in `agents-md` and `plugin-authoring` plugins.
Claude Code 2.1.296 reports the latter as `cc-plugin-plugin-authoring`; both its
legacy alias and canonical settings key are disabled. Empty setting sources
alone do not suppress these built-ins. Initialization still fails closed on any
plugin, skill or slash command that loads; no customization allowlist is added.
This does not change the user's Claude Code settings outside Pix requests.

### Timeout diagnostics

Pi's SDK provider timeout can be raised globally with the existing
`~/.pi/agent/settings.json` setting `retry.provider.timeoutMs` (for example,
`1800000` for 30 minutes). This setting applies across models; an explicit
side-request `timeoutMs` takes precedence. The SDK uses it as a fallback when
no per-call timeout is supplied, while HTTP idle timeout remains a separate
setting. Without either timeout override, the SDK falls back to
`httpIdleTimeoutMs` (default 300000), which the Claude adapter treats as its
total timeout. The local Claude provider still caps its total request budget at
its own configured total timeout (`PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS`,
or its default), so raising the SDK timeout alone does not raise that cap.
Reload the session or restart the host for settings to take effect in new
requests; already-running requests are unchanged.

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

After validated initialization and before the first model `message_start`,
Claude's `api_retry` records are advisory observations only. They do not alter
protocol acceptance, retry/recovery behavior, idle touching, or total, idle,
and MCP-ready deadlines. Schema-5 request metrics add optional
`preStreamRetries: { count, last }` per provider attempt; it is omitted when
there were no such retries and retained by normal finalization on success,
error, or abort. `last` contains an allowlisted category and only valid optional
integer fields (`httpStatus`, `attempt`, `retryDelayMs`). The first retry in an
attempt emits a content-free `suite:pre-stream-retry` warning through the
existing optional Pix `suiteDiagnostics` channel (subject to its usual
cross-request coalescing). The count/latest observation are also available in
the existing optional metrics log and doctor's **Pre-stream retries** line;
this adds neither a log file nor a UI banner.

### Unknown tool name diagnostics

Pi tool names are exposed to Claude Code only as qualified MCP names
(`mcp__pi__Edit` for Pi's `Edit`). Exact catalog lookup takes precedence. A
bare Pi name `N` is also accepted only when it uses 1–48 ASCII letters, digits,
underscores or hyphens, does not start with `mcp__`, and the current catalog
contains exactly `mcp__pi__N -> N` with no other entry mapping to `N`.
This compatibility rule never guesses case, strips foreign namespaces, resolves
hashed/collision aliases, repairs arguments, enables Claude built-ins, or retries.
Tool IDs and arguments are preserved; initialization, Pi argument validation,
process termination, cancellation, private-path and cleanup checks are unchanged.
The content-free `toolNameNormalizationCount` metric counts normalized proposal
starts with valid IDs, even if a later check fails; it is not an execution count.

All other name mismatches fail closed. The existing per-request metrics /
optional metrics log / doctor's
last-request report additionally retain: the safely constrained proposed name,
whether it matches an active but unqualified Pi tool, its expected qualified
name when available, catalog count and sorted-name fingerprint, validated
initialization status, and `pi-tools-suite-vendored` adapter provenance.
Never record tool arguments, request payloads, private paths, the complete
catalog, or arbitrary unvalidated tool-name strings in these diagnostics.
The absence of a persisted metrics log does not turn this into raw protocol
tracing.

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

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"cfb2e6108ef52c90bb910c4e93e49035f1906812085cb8ccfc1ed9d5284358f5","checkedAt":"2026-10-31T13:57:41.370Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":69,"reportLanguage":"ru"} -->
