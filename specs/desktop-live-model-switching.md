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
- Applying a new model during an active run sends the normal ACP `session/set_config_option` request immediately; Desktop does not wait for the prompt to finish before issuing it.
- The ACP adapter applies `model` through Pi's normal `setModel` RPC and `thought_level` through `setThinkingLevel`; there is no ACP idle-only guard around these options.
- This matches TUI behavior: TUI calls `session.setModel()` while `session.isStreaming` is true. The current in-flight model request is not interrupted; the changed session model is used by subsequent model work according to Pi runtime semantics.
- Model-specific resource reload is not forced in the middle of an active run. TUI explicitly skips `session.reload()` while streaming, and Desktop continues to use the existing ACP/Pi model-change path rather than introducing a separate reload or cancellation flow.
- Existing guards still prevent model changes when the Desktop session runtime is unavailable, another config change is in progress, or a conflicting Desktop operation is running.

## Related files

- `desktop/src/App.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/ModelThinkingPicker.svelte`
- `desktop/src/lib/acp-client.ts`
- `acp/src/acp/config-options.ts`
- `acp/src/acp/pix-acp-agent.ts`
- `src/app/commands/command-model-actions.ts`
- `tests/command-model-actions.test.ts`

## Verification

- Desktop source-level regression coverage verifies that `promptRunning` does not disable or reject the combined model/thinking selector.
- TUI unit coverage verifies that a model change still calls `setModel` while streaming and skips only the reload step.
- ACP config-option tests cover model/thinking option validation and routing through the shared Pi RPC surface.
