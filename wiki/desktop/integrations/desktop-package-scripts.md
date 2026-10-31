# Desktop package scripts and terminals

<!-- markdownlint-disable MD013 -->

## Type

Change.

## Lifecycle

Active implemented contract.

## Goal

Expose project-root package scripts, project-defined launch commands, and window-scoped interactive terminals from the Desktop workspace.

## Behavior

- The Launch Commands workspace view treats named project launch commands as the primary project-agnostic surface. If the active project has a root `package.json`, the same view additionally shows its detected package manager and scripts as a compact name-only list; when no root `package.json` exists, package metadata and package-script empty-state warnings are omitted rather than implying that the project is an npm package. The filter matches script names only; command bodies stay out of the list UI.
- The panel offers full create, view, edit, delete, and run controls for named launch commands, independently of whether `package.json` exists. Launch rows use the same compact play affordance as package scripts. A command has a stable id, a non-empty display name, and a non-empty shell command. Deletion requires confirmation; save failures remain visible and do not pretend the change succeeded. Refresh belongs to the shared sidebar header rather than the optional package metadata section.
- The package-script list remains compact and internally scrollable (max-height 11rem) while terminals are present. When there are no terminals and loading has finished, the list expands without its own height limit or scroll area, using the available height in the outer commands container.
- Launch commands belong to the active project and are stored in the separate `launchCommands` array of its `.pi/workspace.jsonc`. Reading supports JSONC; saving preserves unrelated settings and comments. A missing file starts with an empty list. Malformed configuration is not overwritten; an invalid command field reports an error without hiding existing terminals. Conditional writes retry concurrent changes without discarding unrelated settings or other command edits. Loading and saving are guarded against a project switch or panel teardown.
- Successful package-script starts and successful writes of saved launch commands to fresh or reused shells update `recentCommandRuns` in that same `.pi/workspace.jsonc`; `launchCommands` remains unchanged. History keys are `package:<name>` and `launch:<id>`, with Unix-millisecond last-launch timestamps monotonically advanced against local history, not counters. It is restored on workspace load and controller recreation. JSONC-aware compare-and-swap writes preserve comments and unrelated edits, merge concurrent timestamps, and retry a bounded number of times. History persistence is best-effort and logged: failure does not fail a successfully started PTY. An already accepted run persists to its originating workspace even after switching; stale/failed starts and failed shell writes are not recorded. The menu's ranking/frozen-per-opening snapshot behavior is unchanged.
- Running a launch command opens a project-root interactive terminal and sends the saved shell command. The backend terminal snapshot retains the originating launch-command id, so restarting that terminal reruns the latest command definition even after the panel is hidden/reopened or its terminal list is restored. If the command has since been deleted, restart opens a neutral shell instead. A launch never materializes a conversation session.
- Saved launch-command and package-script rows reflect their latest run. Running rows use a green tint and left accent, show a spinner and Stop/Restart actions, and clicking the row focuses the associated terminal instead of starting a duplicate. The row bound to the active terminal has a ring highlight. Starting/running/finished states remain distinguishable; terminal tabs use the launch-command name when available and report `Idle` or `Running` for live shells according to their foreground activity.
- Re-running a launch command reuses its idle shell when possible, otherwise an idle shell previously assigned to another launch command; manual shells are never borrowed. Before typing into a reused shell, the current line is cleared with Ctrl+U. A new shell is created only when no reusable shell is available. Finished tabs for that command are replaced by the new run. Restart reruns in the same shell when it remains reusable; a busy shell is interrupted with Ctrl+C and killed if still busy after 3 seconds.
- Shell activity is determined from the PTY foreground process group using the `package_terminal_activity` and `package_terminal_assign_launch` Tauri commands. Activity is polled every second while shells are live; on non-Unix platforms shells are treated as busy. The shell remains alive when its foreground command exits, ready for reuse.
- Script launches and new-shell launches create backend-managed PTY terminals for the active Desktop window and workspace. Initial terminal dimensions come from the mounted terminal surface when available and otherwise default to 80×24.
- The same PTY/session primitives back two independent Desktop surfaces: the Launch Commands left-sidebar terminal area and the top-level Terminal workbench tab used by composer `!!` commands. Closing the top-level workbench tab removes that UI surface without implicitly stopping its backend PTYs; reopening it restores the window/workspace terminal list, while terminal-level Close/Stop controls retain their existing process semantics.
- Existing window/workspace terminals are restored when the panel loads. The most recent running terminal is preferred as the active tab, otherwise the most recent terminal is selected.
- Workspace loads are generation/workspace guarded so stale package/terminal snapshots cannot overwrite a newer workspace.
- Background updates to unrelated sidebar props must not reload the Launch Commands panel when the workspace path is unchanged, toggle its loading state, or cancel an in-flight terminal action. A real workspace change and the shared header's explicit Refresh still reload the panel.
- Launch, restart, close, and focus continuations retain their originating workspace/lifecycle. A late restart or initial shell command cannot move to a newly selected project. A launch that completes after its panel/workspace owner has been invalidated is stopped and forgotten by its exact terminal id rather than adopted by the new view.
- Terminal output arrives as base64 byte chunks, coalesced natively to at most one event per ~16 ms or 64 KiB; all output read before the PTY closes is emitted before the exit event (bounded by a 1 s drain wait). A per-terminal streaming `TextDecoder` preserves split UTF-8 sequences; the decoder is flushed on exit. Retained frontend output is bounded to 512,000 characters, backend retained PTY output is bounded to 512 KiB, and xterm live scrollback is bounded to 5,000 lines.
- Output for the active terminal is written incrementally into the mounted terminal surface while the same text is retained in terminal state for tab switches/remounts.
- Terminal input and resize operations are accepted only while the terminal is running. Both Desktop terminal surfaces render through the same shared xterm component and rely on xterm's own cursor geometry: a blinking block cursor while focused and the native outline cursor while inactive. Pix does not draw or reposition a second caret overlay. They expose a Pix-owned, persistently visible vertical scrollbar for xterm history instead of relying on macOS overlay-scrollbar policy; xterm's own overlay scrollbar is hidden to avoid a second thumb beside it. Resize is best-effort because the process may exit concurrently.
- Terminal text uses bundled Geist Mono at 10 px through xterm's runtime font configuration, with a terminal-only bundled JetBrainsMono Nerd Font Mono fallback for missing icon/powerline glyphs (including supplementary PUA icons). The fallback loads asynchronously, invalidates xterm's cached font measurements through its public font-family option, and refreshes the still-mounted terminal; a late load cannot refresh an unmounted/replaced terminal. The distributed frontend includes the font's full OFL license. Pix does not override xterm's internal DOM font CSS, avoiding renderer/textarea metric drift. General UI typography remains unchanged.
- The packaged Desktop CSP retains `style-src 'self' 'unsafe-inline'` without Tauri's asset `style-src` nonce/hash injection: xterm's DOM renderer creates runtime `<style>` tags for terminal color, font, and cursor rules without nonces. The exemption is limited to `style-src`; script and other directive injection remains enabled. This permits runtime styles (and weakens style injection protection compared with nonce-only styles), not inline scripts. The release override inherits this base security setting.
- PTY children are launched with `TERM=xterm-256color`, `COLORTERM=truecolor`, `CLICOLOR=1`, and `FORCE_COLOR=3`; inherited `NO_COLOR` / `NODE_DISABLE_COLORS` are removed for this explicitly color-capable terminal surface. Pix additionally advertises `PI_TRUE_COLOR=1` and `PI_HARDWARE_CURSOR=1` to an embedded Pix/Pi TUI, because the child otherwise treats the unknown `TERM_PROGRAM=Pix` conservatively and defaults to a software cursor. ANSI/256-color/truecolor output is preserved and the TUI exposes its real xterm-owned cursor.
- Pix themes only xterm's background, foreground, cursor, and selection. The terminal's ANSI 16-color palette remains xterm's standard palette, while 256-color and truecolor escape sequences are rendered directly instead of being remapped to Pix semantic tool colors. xterm's minimum contrast rewriting stays disabled (`minimumContrastRatio: 1`) so application-selected RGB values are not normalized toward the Desktop foreground color.
- A remounted terminal (switching tabs or reopening the pane) replays the retained output captured when xterm attaches, once, after the first fit frame; live chunks that arrive before that frame are queued and written after the replay, so no output is shown twice. Run-state changes (for example a script exiting) update xterm's stdin/cursor options on the already-mounted terminal.
- Terminal teardown cancels pending initial-render and ResizeObserver fit frames, ignores link resolution success/failure after unmount, and removes active resize/input timers and pointer-drag listeners. A late dynamic import cannot mount an orphaned terminal.
- The `+` shell terminal starts the user's configured shell normally on the PTY instead of suppressing zsh/bash startup files or replacing the prompt. Interactive shell configuration, prompt themes, aliases, and their normal ANSI colors therefore behave the same way they do in a regular terminal, subject to the shell's own configuration.
- Input is serialized per terminal with one IPC write in flight for that terminal. Large pastes are split into native-limit-safe chunks without splitting UTF-16 surrogate pairs, and later keystrokes cannot overtake them. Other terminals are independent. A mounted terminal's callbacks retain that terminal's id through tab switching and final buffer flushes.
- Package terminals have no wall-clock execution timeout: a script or shell runs until the process exits, the user stops it, or workspace/window teardown stops it. Stop uses a short Ctrl+C grace and a bounded forced-kill wait; that stop timeout is cleanup safety, not a command runtime limit. For busy launch-command shells, Stop sends Ctrl+C and kills the shell if it is still busy after 3 seconds; idle shells and package scripts use terminal stop. Restart first stops a running process, forgets the old backend terminal record, then starts the same script or a fresh shell, except that a reusable launch-command shell is rerun in place. A script restart is rejected if that script is no longer present in the current `package.json` snapshot.
- Closing a terminal stops it when necessary, forgets its backend record, removes its decoder/state, and selects a neighboring terminal when the closed tab was active.
- Starting/restarting/closing actions are serialized by panel action state so conflicting terminal mutations are not issued concurrently.

## Related files

- `desktop/src/components/PackageScriptsPanel.svelte`
- `desktop/src/components/TerminalSessionsPane.svelte`
- `desktop/src/components/SavedLaunchCommands.svelte`
- `desktop/src/components/package-scripts-controller.svelte.ts`
- `desktop/src/components/TerminalView.svelte`
- `desktop/src/components/terminal-font.css`
- `desktop/src/components/terminal-font.ts`
- `desktop/src/components/fonts/JetBrainsMonoNerdFontMono-Regular.ttf`
- `desktop/public/fonts/OFL.txt` (Vite copies the full license into the packaged frontend)
- `desktop/src/components/terminal-font.test.ts`
- `desktop/src/components/terminal-view-lifetime.ts`
- `desktop/src/components/terminal-view-lifetime.test.ts`
- `desktop/src/lib/package-scripts.ts`
- `desktop/src/lib/project-launch-commands.ts`
- `desktop/src/lib/project-launch-commands.test.ts`
- `desktop/src/components/PackageScriptsPanel.test.ts`
- `desktop/src/lib/package-scripts.test.ts`
- `desktop/src/lib/terminal-input.ts`
- `desktop/src/lib/terminal-input.test.ts`
- `desktop/src/components/package-scripts-controller.test.ts`
- `desktop/src/components/package-scripts-reactivity.test.ts`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/src/lib/desktop-asset-csp.test.ts`

## Verification

- `desktop/src/lib/package-scripts.test.ts` covers compact name-only package-script filtering, terminal snapshot decoding, bounded output, and status helpers.
- `desktop/src/lib/desktop-asset-csp.test.ts` checks the narrowly scoped style-only Tauri CSP exemption, declared inline style policy, lack of inline script allowance, and release override inheritance.
- Desktop visual/source regressions cover the shared full xterm surface, native block/outline cursor behavior, Geist Mono 10 px terminal font and bundled Nerd fallback, standard ANSI palette retention, color-capable PTY environment, explicit 5,000-line xterm scrollback, visible scrollbar styling, and name-only script rows. The font tests check actual bundled cmap coverage for representative BMP and supplementary Nerd glyphs, the full license in the public assets copied into the Desktop frontend, and guarded DOM width-cache invalidation/repaint on late font loads.
- Terminal lifetime tests use controlled animation frames and link promises to check unmount cancellation, late success/failure suppression, and normal initial/resize/link behavior.
- Input tests use controlled acknowledgements to check ordering, independent terminals, Unicode boundaries, and recovery after failed writes. Controller tests cover workspace changes during launch/restart, initial shell-command ownership, launch reservation, and teardown.
- Client-runes reactivity tests replace spread sidebar props at an unchanged workspace during a launch and initial load; they check that unrelated updates do not reload/cancel work, while real workspace changes still load and reject stale completions.
- Launch-command tests cover JSONC round-tripping alongside other project settings, create/update/delete conflict handling, stale workspace completion, and the UI lifecycle for edit/delete/launch.
- `npm --prefix desktop run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run build:web`

## Evidence

- Confirmed by code: `PackageScriptsPanel.svelte` and `WorkbenchTerminalPane.svelte` both mount the same `TerminalSessionsPane.svelte` + `TerminalView.svelte` terminal surface, while `package-scripts-controller.svelte.ts` owns workspace loading, terminal events, streaming decoders, process mutations, active-terminal selection, and focus handoff.
- Confirmed by code: `desktop/src/lib/package-scripts.ts` defines terminal snapshots/events, base64 decoding, bounded output, filtering, and status presentation helpers.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"e30d3451eff89da6c3f04d182bcbd08452b723fea798ca04abce87a83d8d7583","checkedAt":"2026-10-31T00:57:36.215Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":64,"reportLanguage":"ru"} -->
