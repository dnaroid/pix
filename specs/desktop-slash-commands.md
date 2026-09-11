# Desktop slash commands and fuzzy command search

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make Pi/Pix slash commands discoverable and keyboard-first in Pix Desktop while preserving Pi's native runtime command expansion.

## Scope

- Advertise ACP-supported Pix built-ins and Pi runtime extension, prompt-template, and skill commands through standard ACP `available_commands_update` notifications.
- Fuzzy-match commands by name, alias, description, and source in the Desktop composer.
- Implement `/session` and `/clone` through public Pi RPC methods.
- Implement Desktop-owned `/new`, `/resume`, `/reload`, and `/fork` session actions.
- Implement `/copy` with the same last-assistant-message clipboard semantics as the Pix TUI.
- Open Desktop pickers for argument-free `/model` and `/thinking`, and expose one combined model + thinking picker from the persistent status bar, matching the TUI's model/thinking semantics while adapting the flow for Desktop.
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
- Exact `/new` starts a fresh Desktop conversation. Exact `/resume` opens the Desktop session selector. Argument forms of Desktop-owned commands (`/resume <path>`, `/fork <entry-id>`, `/model <ref>`, `/thinking <level>`) are also intercepted locally; commands with attachments are not intercepted (only `/queue` may carry attachments).
- Exact `/reload` is idle-only and reloads the active Pi session in-process through the ACP extension RPC `pix/session/reload`, then reports completion without sending the command to the model. (Earlier Pi RPC versions had no in-process reload and forced a Desktop subprocess restart; the current pinned RPC supports it.)
- `/fork [entry-id]` is idle-only. With no argument Desktop resolves the newest forkable user-message entry, matching Pix TUI behavior. It creates a new ACP/Pi session before that entry, replaces the active Desktop conversation, reloads the fork history, and restores Pi's selected user text into the composer. Cancellation or failure leaves the source conversation active.
- Exact `/model` and `/thinking` keep their compact searchable command pickers. The status bar instead exposes one `Model · thinking` control. Its combined dialog stages both values locally, keeps the composer draft untouched, and changes the session only after `Apply`; `Cancel`/Escape discard the staged selection. Selecting a model row remains staged until Apply and must not be reset by reactive search/visibility updates.
- Model/thinking config mutations are tracked per session and generation rather than by one global Desktop flag. A slow change in one tab does not disable config controls in another tab; forgetting/reloading a session invalidates the previous generation so stale completion cannot repopulate the refreshed session's config cache or clear a newer same-session operation. The dialog may be closed while Apply is in flight; conflicting picker actions remain disabled, while failures still surface through the Desktop-level error state.
- ACP model config options carry `pix.thinkingLevels` metadata for every available model. Desktop uses the selected model's own metadata to update the thinking choices immediately before switching the live model; it never copies the current model's thinking options onto another model when metadata is unavailable. When a staged/remembered level is unsupported by the selected model it is clamped with the same nearest-level ordering used by Pi.
- Model search follows the TUI contract: the current model is listed first, remaining models sort by `provider/model`, and fuzzy matching considers the full model ref, model id/name, and provider/group. The primary picker label is the technical `provider/model` ref with the friendly model name as secondary text.
- Thinking search follows the TUI contract: it uses only levels advertised by the current session and fuzzy aliases such as `reasoning`, `effort`, `fast`, `extra`, and `maximum`.
- The combined picker keeps fuzzy search on the model list and presents the selected model's supported thinking levels as a compact keyboard-navigable row below it. Model selection and thinking selection remain provisional until Apply.
- Status-bar values and model/thinking picker labels use the TUI's semantic color policy: shipped `modelColors` defaults for Z.AI/OpenAI Codex/Antigravity, stable provider-palette fallback for other providers, and rank-based thinking colors from `off` through `max`.
- Known renderer-owned commands that reach ACP are rejected clearly and never become ordinary model prompts. Unknown runtime commands continue to Pi's native slash-command handling.
- Extension commands and input hooks that consume a prompt without starting an agent run still complete the ACP turn, including prompts with attachments.
- The composer popup opens only for a slash command name at the end of the current draft, supports fuzzy ranking and keyboard navigation, keeps textarea focus, and exposes listbox semantics.
- Enter executes commands with no required input. Optional hints still add a trailing space on Tab completion, while argument-free interactive commands open their picker. Commands with required input remain in the composer unless Desktop supplies a matching picker.

## Related files

- `acp/src/acp/slash-commands.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `acp/src/acp/config-options.ts`
- `acp/src/pi/pi-rpc-client.ts`
- `desktop/src/lib/fuzzy.ts`
- `desktop/src/lib/model-display.ts`
- `desktop/src/lib/model-thinking.ts`
- `desktop/src/lib/command-interactions.ts`
- `desktop/src/lib/slash-commands.ts`
- `desktop/src/components/CommandPicker.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/SessionSelector.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/styles.css`
- `desktop/src/App.svelte`

## Verification

- ACP tests cover catalog ordering and collisions, dynamic commands, built-in execution, renderer-command rejection, no-agent-run commands, and lifecycle races.
- Desktop tests cover fuzzy ranking, model/thinking picker metadata and ordering, TUI-equivalent model/thinking tone selection, query eligibility, insertion, catalog precedence, and strict local command interception.
- `npm --prefix acp run check`
- `npm --prefix desktop test -- --run`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
- `npm run check`

## Risks / unknowns

- `/tree`, `/settings`, `/import`, `/share`, `/trust`, `/login`, and `/logout` still require additional APIs or Desktop UI.
- Desktop `/reload` relies on the private `pix/session/reload` extension RPC rather than a public Pi RPC reload command.
- Desktop `/new` replaces the active ACP runtime; true `/new_tab` behavior needs a separate multi-runtime tab lifecycle.
