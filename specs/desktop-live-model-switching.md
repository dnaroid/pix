# Desktop live model switching

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep Desktop model and thinking selection available while the agent is running, matching the TUI's live model-switch behavior.

## Behavior

- Desktop keeps the combined model/thinking picker enabled while the active session is processing a prompt.
- The same picker is visible on a UI-only New Conversation draft before its first prompt. In that state the selection is staged locally from the sessionless draft config catalogue; it does not require an active session runtime and does not send `session/set_config_option`. The catalogue loads workspace and bundled extensions without creating an `AgentSession`, so extension-registered providers such as pi-tools-suite's Antigravity models are selectable before materialization.
- The draft status bar follows that staged model/thinking selection for provider quota display. Applying a different staged model or thinking level starts a sessionless best-effort quota refresh through `pix/session/draft_config`; it does not materialize the draft or send a live-session config mutation.
- The picker remembers thinking independently per model. The current model begins from the actual session/draft thinking; switching to another model restores that model's staged value from the current picker interaction or its persisted user-level `thinkingByModel` preference, then clamps it to the model's supported thinking levels.
- Applying model/thinking successfully updates the Desktop-only user `~/.config/pi/pix-desktop.jsonc` `thinkingByModel` map. Cancelling the picker does not persist staged-only changes, and project `<project>/.pi/pix-desktop.jsonc` cannot override this user preference. TUI `pix.jsonc` is not read. See `model-thinking-preferences.md`.
- Applying a new model during an active run sends the normal ACP `session/set_config_option` request immediately; Desktop does not wait for the prompt to finish before issuing it.
- The ACP adapter applies `model` through Pi's normal `setModel` RPC and `thought_level` through `setThinkingLevel`; there is no ACP idle-only guard around these options.
- This matches TUI behavior: TUI calls `session.setModel()` while `session.isStreaming` is true. The current in-flight model request is not interrupted; the changed session model is used by subsequent model work according to Pi runtime semantics.
- Model-specific resource reload is not forced in the middle of an active run. TUI explicitly skips `session.reload()` while streaming, and Desktop continues to use the existing ACP/Pi model-change path rather than introducing a separate reload or cancellation flow.
- Existing guards still prevent live-session model changes when the Desktop session runtime is unavailable, another config change is in progress, or a conflicting Desktop operation is running. The runtime-availability guard is intentionally replaced by draft-config availability while the UI-only draft is active.

## Related files

- `desktop/src/app/model-config.svelte.ts`
- `desktop/src/app/model-config-actions.ts`
- `desktop/src/app/model-draft-config.svelte.ts`
- `desktop/src/app/model-picker-state.svelte.ts`
- `desktop/src/app/session-runtime-config.svelte.ts`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/lib/acp-client.ts`
- `desktop/src/lib/acp-pix-extensions.ts`
- `desktop/src/lib/model-thinking.ts`
- `desktop/src/lib/model-thinking-preferences.ts`
- `src/config.ts`
- `schemas/pix-desktop.json`
- `acp/src/acp/config-options.ts`
- `acp/src/acp/draft-model-runtime.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `src/app/commands/command-model-actions.ts`
- `tests/command-model-actions.test.ts`

## Verification

- Desktop source-level regression coverage verifies that `promptRunning` does not disable or reject the combined model/thinking selector.
- Desktop draft coverage verifies that the selector can stage model/thinking before `session/new` and that the staged values are forwarded only on lazy first-prompt materialization.
- Desktop preference coverage verifies cross-picker per-model restoration and JSONC persistence through the user-config compare-and-swap path.
- TUI unit coverage verifies that a model change still calls `setModel` while streaming and skips only the reload step.
- ACP config-option tests cover model/thinking option validation and routing through the shared Pi RPC surface.
