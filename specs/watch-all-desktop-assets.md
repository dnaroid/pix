# watch:all Desktop web asset embedding

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make the newest successfully built Vite bundle available to the Desktop process launched by `npm run watch:all` without interrupting an active session; apply it only after the user explicitly restarts Desktop.

## Behavior

- A Desktop web-source change schedules `web` followed by `native`. The first successful build launches Desktop; later successful builds leave the running Desktop in place and mark the newer build as ready instead of interrupting the active session.
- A watch-launched debug Desktop polls the bounded watcher state artifact and, when a newer build is ready, exposes a `Restart` control at the right side of its titlebar. Activating it launches the new artifact and then exits the old process. Release builds and ordinary development launches have no watcher state and no control.
- `watch:all` disables Tauri's `beforeBuildCommand` because it has already built the web bundle once in the ordered build plan.
- `desktop/src-tauri/build.rs` explicitly tracks the generated `<repo>/desktop/dist/index.html` as a Cargo input. Vite's production entrypoint contains hashed references to the emitted JS/CSS assets, so a successful web rebuild invalidates the native crate even when no Rust source changed.
- The native rebuild therefore regenerates and recompiles Tauri's embedded asset context before the first Desktop launch or a user-requested restart into the newly bundled artifact.
- A failed web/native build keeps the previous working Desktop process alive and does not mark it stale; the watcher never restarts into a partially built frontend.
- macOS launch success is based on the real Tauri app process, not only the
  `/usr/bin/open -n -W` helper. After resolving the exact copied bundle
  executable PID, `watch:all` gives that PID its own startup grace interval and
  verifies it is still present before printing that Desktop is running. A
  short-lived app therefore reports a restart failure instead of a false
  success followed immediately by `desktop stopped`.
- Development/watch native builds do not compile/register the release-only
  Tauri updater plugin, and the watch-built frontend does not start an updater
  check. This avoids requiring release updater configuration in the base Tauri
  config and keeps the debug `.app` launchable.
- Build subprocess output remains streamed to the terminal in real time, but the
  watcher also retains only a bounded tail of the current build step. If that
  command exits unsuccessfully, `watch:all` repeats the retained tail underneath
  a prominent `BUILD FAILED` banner at the bottom of the terminal and emits a
  terminal bell, so compiler errors cannot disappear above a long build log.
- A failed cycle remains explicit in watcher state until a later successful
  cycle. The next relevant edit logs that it is retrying the failed build, and a
  successful recovery is called out before the normal success message.

## Non-goals

- Running a development HTTP server from `watch:all`.
- Rebuilding the web bundle twice per cycle.
- Disabling Cargo incremental compilation for unrelated native-only changes.

## Related files

- `scripts/watch-all.mjs`
- `tests/watch-all.test.ts`
- `desktop/src/app/desktop-watch-restart.svelte.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/DesktopTitlebar.svelte`
- `desktop/src-tauri/build.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/vite.config.ts`

## Verification

- `tests/watch-all.test.ts` covers the ordered `web -> native` build plan, the bounded watcher-state handoff, and the Tauri CLI override that suppresses the duplicate `beforeBuildCommand`.
- `tests/watch-all.test.ts` also covers bounded failed-command output retention
  and the repeated bottom-of-terminal failure report, plus exact app-PID
  liveness checks used by the macOS startup gate.
- After changing/rebuilding Desktop web output, the subsequent native build must rerun the `pix-desktop` build script and produce a launchable bundle with `index.html` embedded.
- Run `npm run test:inner -- --test-name-pattern='watch:all'`, `npm --prefix desktop run check`, and a production Desktop web/native smoke build.
