# Desktop terminal commands (`!` / `!!`)

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Bring the Pix TUI's two bang-command modes to Desktop using the matching Desktop surfaces: `!` stays a one-shot conversation execution, while `!!` uses the existing interactive terminal.

## Behavior

- A non-empty composer input beginning with `!` executes the remainder through the existing Desktop one-shot bash bridge and renders it in the conversation as an execution row.
- A non-empty composer input beginning with `!!` is interactive/raw-terminal mode, matching the Pix TUI contract that `!!command` uses the raw terminal. Desktop opens or activates a dedicated top-level **Terminal** workbench tab beside the surface that launched it, starts a shell PTY in the workspace, writes the command followed by Enter, focuses the terminal, and leaves that terminal session open for further interactive input.
- `!!` never routes through ACP `pix/session/bash`, never creates a conversation execution row, and does not materialize a Pi conversation session merely to run the terminal command. It therefore also works from a UI-only draft conversation.
- Prefix parsing recognizes `!!` before `!`, trims leading and prefix whitespace, and refuses to execute an empty command for bare `!` / `!!` input.
- Bang commands do not accept Desktop image/file attachments. A bang command with attachments is rejected locally rather than silently sending the attachments to the model or terminal.
- `!` is dispatched before the normal prompt queue branch. Only one ACP user-bash execution may be active per session at a time.
- `!` live execution is represented in the Desktop transcript as an auto-expanded `execute` tool row. The auto-open is one-shot, so the user can still collapse it manually afterward; model-initiated bash tools keep the normal collapsed behavior.
- Successful, failed, cancelled, and truncated `!` results reuse Pi's bash result fields, and persisted `bashExecution` messages replay into the same execution-row shape.
- `!!` reuses the existing Desktop PTY stack (`package_terminal_start_shell` + `package_terminal_write`) and the same shared `TerminalSessionsPane` / xterm `TerminalView` used by Package Scripts rather than introducing a second terminal implementation. The Package Scripts left-sidebar view remains a separate consumer of that shared terminal surface; `!!` no longer expands or selects that sidebar view.

## Related files

- `desktop/src/lib/terminal-commands.ts`
- `desktop/src/app/prompt-submit.ts`
- `desktop/src/app/desktop-prompt-action-services.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/DesktopSidebar.svelte`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/components/PackageScriptsPanel.svelte`
- `desktop/src/components/WorkbenchTerminalPane.svelte`
- `desktop/src/components/TerminalSessionsPane.svelte`
- `desktop/src/components/package-scripts-controller.svelte.ts`
- `desktop/src/components/TerminalView.svelte`
- `desktop/src/app/workbench-terminal.svelte.ts`
- `desktop/src/app/workbench-model.ts`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `acp/src/acp/desktop-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/bash-execution.ts`
- `acp/src/acp/session-replay.ts`
- `acp/src/pi/pi-rpc-client.ts`

## Verification

- Desktop parser tests cover `!` chat mode, `!!` interactive mode, leading whitespace, and empty-prefix fallback.
- Desktop submit tests verify that `!!` opens the interactive terminal without materializing/queueing a Pi session and that `!` still uses the one-shot ACP bash path. Workbench model/surface tests pin the dedicated Terminal tab, its close behavior, and the `!!` routing away from the left sidebar.
- Desktop tool-presentation tests verify that one-shot user bash rows are distinguishable from ordinary model bash tools for auto-expansion.
- ACP tests verify the one-shot bash bridge, transcript notifications, and persisted bash-history replay.
- `npm --prefix acp run check`
- `npm --prefix desktop run check`

## Non-goals

- Importing the root renderer's terminal command controller into Desktop or ACP.
- Treating `!` / `!!` as ordinary model prompts or ACP slash commands.
- Reimplementing a second Desktop PTY/terminal stack specifically for `!!`.
