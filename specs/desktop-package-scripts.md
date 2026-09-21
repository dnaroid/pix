# Desktop package scripts and terminals

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Expose project-root package scripts and window-scoped interactive terminals from the Desktop workspace without turning the panel into an arbitrary command launcher.

## Behavior

- The Package Scripts workspace view reads the active project root `package.json`, shows its detected package manager, and renders scripts as a compact name-only list. The filter matches script names only; command bodies stay out of the list UI.
- Script launches and new-shell launches create backend-managed PTY terminals for the active Desktop window and workspace. Initial terminal dimensions come from the mounted terminal surface when available and otherwise default to 80×24.
- Existing window/workspace terminals are restored when the panel loads. The most recent running terminal is preferred as the active tab, otherwise the most recent terminal is selected.
- Workspace loads are generation/workspace guarded so stale package/terminal snapshots cannot overwrite a newer workspace.
- Launch, restart, close, and focus continuations retain their originating workspace/lifecycle. A late restart or initial shell command cannot move to a newly selected project. A launch that completes after its panel/workspace owner has been invalidated is stopped and forgotten by its exact terminal id rather than adopted by the new view.
- Terminal output arrives as base64 byte chunks. A per-terminal streaming `TextDecoder` preserves split UTF-8 sequences; the decoder is flushed on exit. Retained frontend output is bounded to 512,000 characters, backend retained PTY output is bounded to 512 KiB, and xterm live scrollback is bounded to 5,000 lines.
- Output for the active terminal is written incrementally into the mounted terminal surface while the same text is retained in terminal state for tab switches/remounts.
- Terminal input and resize operations are accepted only while the terminal is running. Running terminals use a Pix-owned non-blinking bar caret positioned from xterm's public buffer cursor coordinates, so caret visibility does not depend on xterm focus/inactive-cursor rendering. They also expose a Pix-owned visible vertical scrollbar for xterm history instead of relying on macOS overlay-scrollbar policy. Resize is best-effort because the process may exit concurrently.
- The `+` shell terminal intentionally uses a neutral `pix:<cwd> $` prompt for zsh/bash rather than inheriting decorative shell-theme prompt glyphs such as arrows or dirty-state crosses. This prompt isolation is local to the embedded terminal and does not modify the user's shell configuration files.
- Input is serialized per terminal with one IPC write in flight for that terminal. Large pastes are split into native-limit-safe chunks without splitting UTF-16 surrogate pairs, and later keystrokes cannot overtake them. Other terminals are independent. A mounted terminal's callbacks retain that terminal's id through tab switching and final buffer flushes.
- Package terminals have no wall-clock execution timeout: a script or shell runs until the process exits, the user stops it, or workspace/window teardown stops it. Stop uses a short Ctrl+C grace and a bounded forced-kill wait; that stop timeout is cleanup safety, not a command runtime limit. Restart first stops a running process, forgets the old backend terminal record, then starts the same script or a fresh shell. A script restart is rejected if that script is no longer present in the current `package.json` snapshot.
- Closing a terminal stops it when necessary, forgets its backend record, removes its decoder/state, and selects a neighboring terminal when the closed tab was active.
- Starting/restarting/closing actions are serialized by panel action state so conflicting terminal mutations are not issued concurrently.

## Related files

- `desktop/src/components/PackageScriptsPanel.svelte`
- `desktop/src/components/package-scripts-controller.svelte.ts`
- `desktop/src/components/TerminalView.svelte`
- `desktop/src/lib/package-scripts.ts`
- `desktop/src/lib/package-scripts.test.ts`
- `desktop/src/lib/terminal-input.ts`
- `desktop/src/lib/terminal-input.test.ts`
- `desktop/src/components/package-scripts-controller.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

- `desktop/src/lib/package-scripts.test.ts` covers compact name-only package-script filtering, terminal snapshot decoding, bounded output, and status helpers.
- Desktop visual/source regressions cover the visible terminal caret, explicit 5,000-line xterm scrollback, visible scrollbar styling, and name-only script rows.
- Input tests use controlled acknowledgements to check ordering, independent terminals, Unicode boundaries, and recovery after failed writes. Controller tests cover workspace changes during launch/restart, initial shell-command ownership, launch reservation, and teardown.
- `npm --prefix desktop run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run build:web`

## Evidence

- Confirmed by code: `PackageScriptsPanel.svelte` owns the declarative script/terminal surface while `package-scripts-controller.svelte.ts` owns workspace loading, terminal events, streaming decoders, process mutations, active-terminal selection, and focus handoff.
- Confirmed by code: `desktop/src/lib/package-scripts.ts` defines terminal snapshots/events, base64 decoding, bounded output, filtering, and status presentation helpers.
