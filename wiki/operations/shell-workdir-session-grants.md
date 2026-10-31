---
kind: spec
status: active
---

# Session-only shell working directories

## Behavior

The model-tools `shell` alias accepts a `workdir` inside the current workspace by default. A user may run `/shell-workdir allow <path>` to grant one additional existing directory to this session's shell alias. The grant covers that directory and its descendants. `/shell-workdir list` shows canonical granted paths; `/shell-workdir revoke <path>` removes an individual grant. Commands report the canonical path and that grants last **only for the current session**, and are cleared on session replacement, reload, or exit. Paths containing spaces are accepted as the entire argument after the action. A revoked directory is denied again unless covered by another explicit grant or the workspace. The workspace remains allowed without an explicit grant.

In Pix Desktop, submit the slash command from the composer. Its `ctx.ui.notify` result appears in the conversation as command feedback (including the empty-list message); the ACP bridge forwards notifications from active slash prompts rather than discarding them. Outside commands, extension warning/error notifications (including startup failures) also become live system rows; informational notifications stay quiet.

## Turning the restriction off

The boundary is on by default. Setting `"restrictShellWorkdir": false` in the user-level
Tools Suite config (`~/.config/pi/pi-tools-suite.jsonc`, or `pi-tools-suite.jsonc` under
`PI_CONFIG_DIR`) lets the shell alias use any existing directory without a grant. Desktop
exposes it as **Restrict shell working directory** in Tools Suite → General.
`PI_TOOLS_SUITE_RESTRICT_SHELL_WORKDIR=1/0` overrides both files. A repository's
`.pi/pi-tools-suite.jsonc` cannot change it in either direction, so cloning a project never
widens agent access. The value is read on every shell call and on `/shell-workdir list`,
so a change applies without reload; an unreadable config keeps the restriction on and
logs a `workdir-config-failed` diagnostic. The working directory must still exist and is
resolved with `realpath`. While unrestricted, `list` reports that instead of grants;
existing grants remain in memory and apply again when the restriction returns.

## Constraints and failure cases

- The permission is held only in extension memory keyed to its session manager. It is not written to config or session history and is not inherited by resumed/forked sessions, other tabs, or child-agent runtimes. Session start/shutdown clears that session's grants, including reload, without disturbing another active session in a shared extension runtime. In-flight commands cannot commit a grant to a replacement session.
- Grant and shell execution use `realpath`: nonexistent paths, dangling links, and files cannot be granted. A symlink grant names its resolved target, not the link. `../` and symlink traversal are evaluated against the resolved workspace and grant roots using path boundaries, not string prefixes. A symlink changed after granting cannot redirect shell to an unrelated target. A removed grant can be revoked by the canonical path shown in `list` when its parent still exists.
- While the restriction is on, everything else outside the workspace remains denied with `Working directory escapes workspace`; the message names both the session grant and the user setting. This is a *working-directory restriction*, **not** a filesystem sandbox: shell commands can themselves access other paths.
- The grant applies to the model-tools `shell` alias, not the raw terminal, built-in Bash or other tools. If the model-tools extension is not loaded, the slash command is unavailable.

## Implementation

- `external/pi-tools-suite/src/model-tools/index.ts::runShellAlias`
- `external/pi-tools-suite/src/model-tools/shell-workdir.ts::registerShellWorkdir`
- `external/pi-tools-suite/src/model-tools/path-utils.ts::isPathInside`
- `external/pi-tools-suite/src/config.ts::loadPiToolsSuiteConfig` (`restrictShellWorkdir`, user layers only)
- `acp/src/acp/pix-acp-agent.ts::handleExtensionUiRequest`

## Tests

- `external/pi-tools-suite/test/shell-workdir.test.ts`
- `external/pi-tools-suite/test/model-tools.test.ts`
- `external/pi-tools-suite/test/config.test.ts`
- `acp/test/agent.test.ts`

## Verification

Run suite typecheck, suite tests and smoke, plus the Pix root check and suite integration test. The deterministic shell alias tests exercise grant/revoke, canonical descendant and link behavior, denied paths, missing directories, and session/runtime boundaries.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"3c287c7dff24947ef963fa091423455b86f4b554714a491c375e3e9b60b47ae0","checkedAt":"2026-10-31T00:02:28.982Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":69,"reportLanguage":"ru"} -->
