# Desktop command palette and command registry

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix Desktop one reusable command vocabulary for keyboard shortcuts, command-palette discovery, persistent chrome hints, composer actions, and user-message context actions without moving stateful execution out of the component/application owner that already controls it.

## Behavior

- Desktop command metadata lives in `desktop/src/lib/desktop-commands.ts` under stable namespaced ids rather than using the rendered label as identity.
- A command definition may provide label, description, scope, search keywords, optional shortcut, and destructive semantics. Stateful enablement and execution remain with the application/component that owns the affected state.
- `Command+Shift+P` on macOS and `Ctrl+Shift+P` on Windows/Linux open the application Command Palette when a higher-priority blocking modal is not active. Pressing the shortcut again while that palette is open closes it.
- `Command+T` on macOS and `Ctrl+T` on Windows/Linux create a fresh conversation when session creation is currently available. The same shortcut definition supplies the visible titlebar hint and the keyboard matcher.
- The Command Palette reuses the existing searchable `CommandPicker` surface and its search, Arrow Up/Down, Home/End, Enter, native-dialog Escape, scroll-into-view, backdrop dismissal, and focus-restoration behavior.
- The palette exposes application/workspace/session/editor commands whose enablement can be evaluated without additional user context: Open Project, New/Open Conversation, Focus Composer, Jump to User Message, Prompt History, Select Model and Thinking, Toggle Session Activity, and contextually relevant workspace-editor commands.
- Workspace-editor commands are **Show Conversation**, **Show Preview**, **Show Git Diff**, and **Close Active Editor**. They appear only while their target/action is meaningful, and they operate on the central editor layer without changing conversation Session-tab membership.
- The palette remains available while Preview or Git Diff is the active editor because those are ordinary workbench surfaces rather than blocking modals. A higher-priority bounded modal such as form elicitation still prevents opening another application palette.
- Commands that require a concrete message or draft context remain contextual and are not promoted into the global palette merely because their metadata is centralized.
- Composer overflow actions and user-message context-menu labels reuse the shared command definitions; their existing local enablement and handlers remain authoritative.
- The status bar exposes a compact Command Palette action and shows the platform shortcut in its tooltip. This is a stable discoverability path in addition to the keyboard shortcut.

## Invariants

- A shortcut must not have a separately hand-authored display string that can drift from the matcher.
- Command metadata is presentation/discovery metadata, not a replacement for session/workspace state ownership.
- Opening the palette does not submit prompts, mutate session membership, or alter the transcript.
- Existing slash-command pickers for model, thinking, jump, and prompt history continue to use the same picker component without changing their command semantics.
- Contextual user-message actions remain exactly Copy message, Fork, Fork in new tab, and Undo changes.

## Related files

- `desktop/src/lib/desktop-commands.ts`
- `desktop/src/lib/command-interactions.ts`
- `desktop/src/components/CommandPicker.svelte`
- `desktop/src/components/StatusBar.svelte`
- `desktop/src/components/PromptComposer.svelte`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/WorkspaceEditorTabs.svelte`
- `desktop/src/lib/workspace-editors.ts`
- `desktop/src/App.svelte`

## Verification

- `desktop/src/lib/desktop-commands.test.ts` covers centralized metadata, platform shortcut labels, and shortcut matching.
- `desktop/src/lib/command-interactions.test.ts` covers command-registry rows mapped into the shared picker.
- `npm --prefix desktop test`
- `npm --prefix desktop run check`
- `npm --prefix desktop run build:web`
