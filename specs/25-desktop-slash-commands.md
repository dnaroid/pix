# Spec: Desktop slash commands and fuzzy command search

## Type

Change

## Goal

Make Pi/Pix slash commands discoverable and keyboard-first in Pix Desktop while preserving Pi's native runtime command expansion.

## Scope

- Advertise ACP-supported Pix built-ins and Pi runtime extension, prompt-template, and skill commands through standard ACP `available_commands_update` notifications.
- Fuzzy-match commands by name, alias, description, and source in the Desktop composer.
- Implement `/session` and `/clone` through public Pi RPC methods.
- Implement Desktop-owned `/new`, `/resume`, `/reload`, and `/fork` session actions.
- Implement `/copy` with the same last-assistant-message clipboard semantics as the Pix TUI.
- Open Desktop pickers for argument-free `/model` and `/thinking`, matching the TUI's secondary command menus.
- Reuse the Desktop fuzzy-search utility in the session selector.

## Non-goals

- Pretending renderer-only Pix commands work by forwarding them as model prompts.
- Porting unrelated terminal pickers, settings, authentication, tree navigation, import/share, or process-lifecycle commands without matching Desktop UI or Pi RPC support.
- Importing the root renderer's terminal command controller into Desktop or ACP.

## Behavior

- The merged Desktop catalog contains `/new`, `/resume`, `/reload`, `/fork`, the interactive Desktop overrides for `/model` and `/thinking`, ACP built-ins including `/copy`, and then Pi runtime commands.
- Built-in names and aliases take precedence over runtime command collisions. Renderer-owned Pix names are also withheld from the runtime catalog.
- Command discovery failures are non-fatal: supported ACP built-ins remain available.
- `/name` with no argument reports the current name; with an argument it renames the session.
- `/session` reports message, tool, token, and cost totals from Pi RPC.
- `/clone` clones the current Pi branch and refreshes the persisted ACP-to-Pi session mapping.
- `/copy` copies the complete plain text of the last assistant message. No assistant message and OS clipboard failures are distinct user-visible errors.
- Intercepted built-ins are serialized with prompts so session mutations such as `/clone` cannot overlap another run.
- Exact `/new` starts a fresh Desktop conversation. Exact `/resume` opens the Desktop session selector. Argument forms and commands with attachments are not intercepted locally.
- Exact `/reload` is idle-only and restarts the Desktop ACP/Pi connection, reloads the saved active session, and reports completion without sending the command to the model. This is a Desktop process reload because Pi RPC 0.85.0 has no in-process reload command.
- `/fork [entry-id]` is idle-only. With no argument Desktop resolves the newest forkable user-message entry, matching Pix TUI behavior. It creates a new ACP/Pi session before that entry, replaces the active Desktop conversation, reloads the fork history, and restores Pi's selected user text into the composer. Cancellation or failure leaves the source conversation active.
- Exact `/model` and `/thinking` open compact searchable Desktop pickers sourced from ACP config options. Selecting an item executes the corresponding argument form; Escape cancels without changing the session.
- Known renderer-owned commands that reach ACP are rejected clearly and never become ordinary model prompts. Unknown runtime commands continue to Pi's native slash-command handling.
- Extension commands and input hooks that consume a prompt without starting an agent run still complete the ACP turn, including prompts with attachments.
- The composer popup opens only for a slash command name at the end of the current draft, supports fuzzy ranking and keyboard navigation, keeps textarea focus, and exposes listbox semantics.
- Enter executes commands with no required input. Optional hints still add a trailing space on Tab completion, while argument-free interactive commands open their picker. Commands with required input remain in the composer unless Desktop supplies a matching picker.

## Related files

- `acp/src/acp/slash-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `desktop/src/lib/fuzzy.ts`
- `desktop/src/lib/slash-commands.ts`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/SessionSelector.svelte`
- `desktop/src/App.svelte`

## Verification

- ACP tests cover catalog ordering and collisions, dynamic commands, built-in execution, renderer-command rejection, no-agent-run commands, and lifecycle races.
- Desktop tests cover fuzzy ranking, query eligibility, insertion, catalog precedence, and strict local command interception.
- `npm --prefix acp run check`
- `npm --prefix desktop test -- --run`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`

## Risks / unknowns

- `/tree`, `/settings`, `/import`, `/share`, `/trust`, `/login`, and `/logout` still require additional APIs or Desktop UI.
- Desktop `/reload` restarts the ACP/Pi subprocess boundary rather than calling `AgentSession.reload()` because that operation is absent from the pinned public RPC protocol.
- Desktop `/new` replaces the active ACP runtime; true `/new_tab` behavior needs a separate multi-runtime tab lifecycle.
