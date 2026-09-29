---
kind: spec
status: active
---

# Session-only shell working directories

## Behavior

The model-tools `shell` alias accepts a `workdir` inside the current workspace by default. A user may run `/shell-workdir allow <path>` to grant one additional existing directory to this session's shell alias. The grant covers that directory and its descendants. `/shell-workdir list` shows canonical granted paths; `/shell-workdir revoke <path>` removes an individual grant. Commands report the canonical path and that grants last **only for the current session**, and are cleared on session replacement, reload, or exit. Paths containing spaces are accepted as the entire argument after the action. A revoked directory is denied again unless covered by another explicit grant or the workspace. The workspace remains allowed without an explicit grant.

In Pix Desktop, submit the slash command from the composer. Its `ctx.ui.notify` result appears in the conversation as command feedback (including the empty-list message); the ACP bridge forwards notifications from active slash prompts rather than discarding them. Other extension UI notifications outside slash prompts are not turned into conversation messages.

## Constraints and failure cases

- The permission is held only in extension memory keyed to its session manager. It is not written to config or session history and is not inherited by resumed/forked sessions, other tabs, or child-agent runtimes. Session start/shutdown clears that session's grants, including reload, without disturbing another active session in a shared extension runtime. In-flight commands cannot commit a grant to a replacement session.
- Grant and shell execution use `realpath`: nonexistent paths, dangling links, and files cannot be granted. A symlink grant names its resolved target, not the link. `../` and symlink traversal are evaluated against the resolved workspace and grant roots using path boundaries, not string prefixes. A symlink changed after granting cannot redirect shell to an unrelated target. A removed grant can be revoked by the canonical path shown in `list` when its parent still exists.
- Everything else outside the workspace remains denied with `Working directory escapes workspace`; no global guard is disabled. This is a *working-directory restriction*, **not** a filesystem sandbox: shell commands can themselves access other paths.
- The grant applies to the model-tools `shell` alias, not the raw terminal, built-in Bash or other tools. If the model-tools extension is not loaded, the slash command is unavailable.

## Implementation

- `external/pi-tools-suite/src/model-tools/index.ts::runShellAlias`
- `external/pi-tools-suite/src/model-tools/shell-workdir.ts::registerShellWorkdir`
- `external/pi-tools-suite/src/model-tools/path-utils.ts::isPathInside`
- `acp/src/acp/pix-acp-agent.ts::handleExtensionUiRequest`

## Tests

- `external/pi-tools-suite/test/shell-workdir.test.ts`
- `external/pi-tools-suite/test/model-tools.test.ts`
- `acp/test/agent.test.ts`

## Verification

Run suite typecheck, suite tests and smoke, plus the Pix root check and suite integration test. The deterministic shell alias tests exercise grant/revoke, canonical descendant and link behavior, denied paths, missing directories, and session/runtime boundaries.
