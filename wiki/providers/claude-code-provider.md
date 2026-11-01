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

### Multiple Claude subscription profiles

Opt-in `claudeCodeProvider` settings live **only** in the user-level
`~/.config/pi/pi-tools-suite.jsonc`, shared by Pix Desktop/ACP and TUI. A
workspace's project config cannot supply OAuth paths. Desktop Settings → Tools
Suite → Claude Accounts edits this file through the existing validated settings
editor; no login tokens are read, copied, stored, or displayed by Pix. The
account editor supports naming, ordering, adding, removing and copying CLI
commands to log in/check status with a separate `CLAUDE_CONFIG_DIR`. The toggle
is disabled until at least two profiles are listed. Saving changes takes effect
on the next provider request; an existing in-flight request keeps its snapshot.

Desktop Session usage, when the active model is Claude Code or the session
has recorded Claude Code calls, includes a
compact account selector between `Session usage` and `Subagents`. It reads
only the user-level Tools Suite config when opened. `Default` with rotation
off uses the ordinary Claude CLI login; `Auto` with rotation on clears the
manual preference. Choosing a named profile writes `selectedAccount` under
`claudeCodeProvider` via a compare-and-swap JSONC edit that preserves other
settings and detects concurrent saves. This is a global **preferred account
for the next model request**, not a change to an in-flight call; it also works
while automatic rotation is off. With rotation enabled, the selected account
is attempted first, and its quota rejection still triggers the bounded
fallback and optional pause. Explicit preference changes clear only that
account's process-local cooldown once; no account is retried twice in one
request. Renaming/removing the preferred profile in Settings clears it, and an
invalid stale name in manually edited JSONC falls back instead of blocking
the provider.

Each attempt publishes only a profile label and timestamp through the
session-owned `claude-code-account` event, allowing Desktop to show
`Last: <label>`. This identifies an attempted account, not a confirmed
successful login. The selector does not automatically refresh subscription
usage or relabel existing quota bars: previously displayed quotas may belong
to the prior login. The UI displays no OAuth tokens or private config paths.
All file reads/writes are asynchronous and scoped to the lifetime of the
popup, and a concurrent-file conflict does not overwrite newer settings.

Example (each directory must first be authenticated with Claude Code CLI):

```jsonc
"claudeCodeProvider": {
  "autoRotate": true,
  "rotationDelaySeconds": 60,
  "accounts": [
    { "name": "Personal", "configDir": "~/.claude-personal" },
    { "name": "Work", "configDir": "~/.claude-work" }
  ]
}
```

In Desktop Settings → Tools Suite → Claude Accounts, the **Claude quota
warnings** switch is discoverable through settings search, including quota and
rate-limit terms, and controls whether the provider displays notices for Claude's
`allowed_warning` rate-limit events. Its user-only setting is
`claudeCodeProvider.showRateLimitWarnings` in
`~/.config/pi/pi-tools-suite.jsonc`; it defaults to `false`. The provider reads
this preference during initialization, so reload/restart sessions to apply a
change. Disabling these notices suppresses only the `allowed_warning` UI
notifications: structured quota telemetry, rejected-quota notifications/errors
and account-rotation warnings are unchanged.

When disabled or absent, Claude Code retains its original single-profile login
behavior. With rotation enabled, startup checks the first configured profile,
not the implicit default `~/.claude`. Per-request model subprocesses receive
a pinned `CLAUDE_CONFIG_DIR`; neither mutates `process.env` nor forwards an
OAuth token. The provider-specific `pi_claude_code_provider_web_search` tool
is not registered or used; the suite's separate `web_search`/`web_fetch`
tools are unchanged.
Two profiles with the same
resolved path or duplicate names are invalid; the backend rejects malformed
configuration rather than silently choosing the wrong login.

Only a **structured** `rate_limit_event` with `status: rejected` and
`rateLimitType` of `five_hour` or `seven_day` qualifies for failover. A request
starts at the selected available account and visits each configured account at
most once; rate-limited accounts enter a shared process-wide cooldown until
their reported reset time (or two minutes when unknown), capped at eight days.
Concurrent requests may already be using the same account when a rejection
arrives; subsequent selections honor the cooldown. A profile becomes eligible
again after its reset. No implicit rotation happens for auth, transport,
overload, cancellation, or other errors, nor after any model content or tool
call has started streaming. Pre-output rejections discard the abandoned
attempt's start/error events, preserving a single logical Pi stream. Retries
reuse the remaining request deadline, not a fresh timeout per profile.

After a confirmed quota rejection, the provider waits
`claudeCodeProvider.rotationDelaySeconds` seconds before attempting another
eligible account. This is a **non-blocking, abortable pause**, with an integer
setting of 0–300 seconds and a 60-second default; omitting the setting still
waits 60 seconds, while explicit 0 disables the pause. It is never applied to
the first attempt, ordinary errors or an already-exhausted account pool.
Before the wait, the session receives a warning naming the rejected account and
duration. The selected next profile is re-evaluated after the wait, because
another concurrent request may exhaust that profile in the meantime. The
wait consumes the same overall request timeout; if there is insufficient time
for the configured pause, the provider returns a terminal timeout error rather
than launching another process or waiting indefinitely. Cancellation clears
the timer and aborts the request without switching. The additional delay is a
user-experience safety bound, **not** a guarantee of compliance with Anthropic's
account or rate-limit terms.

If every profile is blocked or has rejected this request, stop with one normal
provider error that identifies the exhaustion and (when known) the earliest
reset; do not recursively requeue or spin. The existing quota-wait extension
may handle the final exhausted error after the turn as before. Automatic
switches emit a session-scoped warning that names the two profile labels (never
credential material). Structured quota telemetry carries the originating Pi
session/model for provenance validation, but accepted samples are shared across
Claude Code routes and sessions within one Pix process, not owned by that
session/model. This is **not** a combined balance across accounts: the current
cache assumes one Claude Code login per process and samples carry no account
identity. With account rotation, one account's consumption can therefore appear
on another account's session until polling or a subsequent event corrects it.
Per-account telemetry isolation would require account identifiers and a cache
keyed by them; it is not implemented. See the
[runtime quota contract](../usage/desktop-runtime-status.md).

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

This transport has no provider-specific pruning setting. The suite-wide
experimental `pruneHistoricalThinking` setting (module
`historical-thinking-prune`, see `wiki/context/historical-thinking-prune.md`) removes
earlier-turn thinking in Pi's `context` event, before this serializer runs, so
it applies to Claude Code like any other provider.

### Desktop sign-in recovery

Claude authentication error cards offer **Sign in to Claude**. This is an
explicit user action, not a background login or an automatic task retry. Only
host provider/extension error rows identifying Claude Code and expired OAuth,
failed authentication or a missing login qualify; unrelated provider errors,
quota warnings and ordinary transcript text do not.

Historical authentication error cards and their text remain in the transcript,
but the complete sign-in recovery block (profile selection, login action,
Continue action and guidance) is shown only for the final transcript item when
no prompt is running. Starting a retry hides stale recovery controls without
removing the error; a later final authentication error offers recovery again.

The action reads only the user-level Tools Suite configuration. With no named
profiles it opens Pix's existing Terminal workbench and runs Claude's
`auth login --claudeai`; with named profiles it first offers a Pix-styled
profile selector and requires confirmation. The initial choice uses the saved
preference, the first rotation profile, or Default when rotation is off. This
choice is local to sign-in and does not change provider account preferences.
Named profiles pin `CLAUDE_CONFIG_DIR`; Default inherits the terminal's ordinary
Claude configuration. The command honors `PI_CLAUDE_CODE_PROVIDER_PATH` from the
terminal environment, falling back to `claude`. Profile paths are shell-quoted,
and CR/LF/NUL paths are rejected before writing into the PTY.

Configuration is reread before launch so a changed path is used; removing the
chosen profile requires another selection/confirmation rather than silently
logging into Default. Repeated clicks are ignored while that action is pending,
and stale configuration completions after unmount/session changes never launch
a terminal. Config/launch failures have visible retry feedback and sanitized
diagnostic reports. Terminal launch failures and a busy terminal propagate to
the caller instead of looking like a successful launch.

Claude CLI owns the browser flow and credential storage. Pix never reads,
copies or displays tokens, and opening the terminal is not proof of successful
authentication. The user completes the terminal/browser flow, returns to the
conversation and retries the request. A provider disabled by startup preflight
still needs a reload/restart after sign-in; recovery does not re-register it.

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
