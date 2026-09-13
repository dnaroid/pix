# Desktop package scripts and terminals

<!-- markdownlint-disable MD013 -->

## Type

As-is.

## Lifecycle

Active implemented contract.

## Goal

Expose project-root package scripts and window-scoped interactive terminals from the Desktop workspace without turning the panel into an arbitrary command launcher.

## Behavior

- The Package Scripts workspace view reads the active project root `package.json`, shows its detected package manager and scripts, and filters scripts by name or command text.
- Script launches and new-shell launches create backend-managed PTY terminals for the active Desktop window and workspace. Initial terminal dimensions come from the mounted terminal surface when available and otherwise default to 80×24.
- Existing window/workspace terminals are restored when the panel loads. The most recent running terminal is preferred as the active tab, otherwise the most recent terminal is selected.
- Workspace loads are generation/workspace guarded so stale package/terminal snapshots cannot overwrite a newer workspace.
- Terminal output arrives as base64 byte chunks. A per-terminal streaming `TextDecoder` preserves split UTF-8 sequences; the decoder is flushed on exit and retained output remains bounded by the package-terminal helper.
- Output for the active terminal is written incrementally into the mounted terminal surface while the same text is retained in terminal state for tab switches/remounts.
- Terminal input and resize operations are accepted only while the terminal is running. Resize is best-effort because the process may exit concurrently.
- Stop requests terminate a running terminal. Restart first stops a running process, forgets the old backend terminal record, then starts the same script or a fresh shell. A script restart is rejected if that script is no longer present in the current `package.json` snapshot.
- Closing a terminal stops it when necessary, forgets its backend record, removes its decoder/state, and selects a neighboring terminal when the closed tab was active.
- Starting/restarting/closing actions are serialized by panel action state so conflicting terminal mutations are not issued concurrently.

## Related files

- `desktop/src/components/PackageScriptsPanel.svelte`
- `desktop/src/components/package-scripts-controller.svelte.ts`
- `desktop/src/components/TerminalView.svelte`
- `desktop/src/lib/package-scripts.ts`
- `desktop/src/lib/package-scripts.test.ts`
- `desktop/src-tauri/src/lib.rs`

## Verification

- `desktop/src/lib/package-scripts.test.ts` covers package-script filtering, terminal snapshot decoding, bounded output, and status helpers.
- `npm --prefix desktop run check`
- `npm --prefix desktop test`
- `npm --prefix desktop run build:web`

## Evidence

- Confirmed by code: `PackageScriptsPanel.svelte` owns the declarative script/terminal surface while `package-scripts-controller.svelte.ts` owns workspace loading, terminal events, streaming decoders, process mutations, active-terminal selection, and focus handoff.
- Confirmed by code: `desktop/src/lib/package-scripts.ts` defines terminal snapshots/events, base64 decoding, bounded output, filtering, and status presentation helpers.
