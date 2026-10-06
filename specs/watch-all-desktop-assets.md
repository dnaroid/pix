# watch:all Desktop web asset embedding

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Make the newest successfully built Vite bundle available to the Desktop process launched by `npm run watch:all` without interrupting an active session; apply it only after the user explicitly restarts Desktop.

## Behavior

- The development-only `scripts/pix-watch` launcher can be symlinked onto
  `PATH` as `pix-watch`. It resolves absolute/relative symlinks to its checkout,
  changes to that root, and execs `npm run watch:all` with forwarded arguments
  and npm from `PATH`. It does not require Zed or install a background service;
  the terminal remains open and `Ctrl+C` stops the watcher normally.
- On macOS, normal watcher shutdown (including `Ctrl+C`) requests AppKit Quit
  from the exact native Desktop PID, then waits up to 30 seconds for its clean
  exit and window-state save. It does not send `SIGTERM`/`SIGKILL` to Desktop.
  Only after the app exits may it clean up the launch helper. A refused/failed
  Quit, unidentified live app, or timeout reports a failed shutdown and retains
  the app/helper and their bundles rather than interrupting persistence.
- A Desktop web-source change schedules `web` followed by `native`. The first successful build launches Desktop; later successful builds leave the running Desktop in place and mark the newer build as ready instead of interrupting the active session.
- Changes to `desktop/src/**/*.test.ts` (Desktop's Vitest file convention)
  do not schedule a rebuild. Production Svelte, TypeScript, and CSS sources
  remain build triggers. This classification also applies to the Git reflog
  fallback; initial builds and conservative failed-diff rebuilds are unchanged.
- `watch:all` also watches the repository HEAD reflog as a fallback for Git worktree integrations such as `pull`, fast-forward `merge` (including Desktop's **Update project**), rebase, and reset. When HEAD advances through one of those operations, it diffs the old/new commits, classifies the changed paths with the same build-part rules, and queues the affected parts even if the OS file watcher missed some or all of the bulk checkout events. Ordinary local commits and branch checkouts do not use this fallback. If the bounded Git diff probe fails, the watcher conservatively queues all parts.
- A watch-launched debug Desktop polls the bounded watcher state artifact and, when a newer build is ready, exposes a `Restart` control at the right side of its titlebar. Activating it requests a clean exit of the old process; the watcher waits for that process to finish saving window membership/geometry and cleaning up before launching the new artifact. It never sends termination signals during this handoff. If the old process has not exited within 30 seconds, the restart fails without killing it or launching a competing instance. Release builds and ordinary development launches have no watcher state and no control.
- The same debug-only state carries `buildStatus` (`idle`, `queued`, `building`,
  `failed`; absent means `idle` for older watcher state). Desktop shows a clock
  for queued work, a reduced-motion-aware spinner during a build, and a red
  failure icon with a tooltip pointing to the watcher terminal. These passive
  indicators sit immediately left of Restart and also appear when no restart
  is available. Successful completion clears the indicator; any previously
  ready artifact stays restartable while subsequent work is queued/building or
  fails. Edits during a build keep the building indicator until that cycle
  finishes, then show queued work. State writes are serialized so older
  asynchronous publications cannot overwrite newer status/artifact snapshots.
  Desktop polling never overlaps within an active lifecycle and ignores
  completion after teardown (a new lifecycle need not wait for an abandoned poll);
  watcher file/target inspection runs on a native blocking worker, not the UI
  thread. A late restart error after teardown does not restart polling.
- `watch:all` disables Tauri's `beforeBuildCommand` because it has already built the web bundle once in the ordered build plan.
- Every native watch build uses the persistent, isolated
  `desktop/src-tauri/target/watch-all` cache with `CARGO_INCREMENTAL=0` and
  `CARGO_PROFILE_DEV_DEBUG=0`, overriding inherited values for that subprocess.
  This avoids retaining rustc incremental state for repeatedly changing embedded
  assets and reduces debug artifact size. It remains a Tauri debug build; compiled
  dependencies are reused, and ordinary native/release builds are unchanged.
  Before each native build it runs `cargo clean --package pix-desktop` with an
  explicit manifest and `--target-dir` pointing only to that watch cache. This
  removes obsolete content-hashed Tauri embedded assets and application outputs
  under Cargo's lock, not dependencies or the running Desktop's copied bundle.
  A cleanup failure aborts the build without publishing an artifact. Other target
  directories and obsolete dependency artifacts are not automatically cleaned.
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
- Each successful native build gets a distinct copied debug bundle so its
  executable path identifies the launched macOS process. The watcher removes
  superseded copies after publication and restart, but retains the running app,
  an in-flight launch, the latest build, and any app still visible in the
  process list. A failed copy/signing removes its incomplete destination.
- On macOS startup, the watcher reclaims abandoned `pix-watch-all-*` temporary
  roots only after checking their owner PID and process commands for a running
  app/helper using that exact root. A missing or invalid process snapshot
  prevents cleanup. Pre-owner-marker roots are eligible only after an hour and
  when no other watcher is running; recent/ambiguous roots are left intact.
  Shutdown likewise retains a root if its Desktop process survives termination.

## Non-goals

Ordinary native UI QA consumes a pinned successful watch artifact through
`qa:desktop`, without restarting the working Desktop or changing this watcher's
lifecycle. See `specs/desktop-qa-isolated-launch.md`. QA owns its copy/profile and
cleanup; the watcher remains only the producer. Restart/recovery testing remains
a separate explicitly requested scenario.

- Running a development HTTP server from `watch:all`.
- Rebuilding the web bundle twice per cycle.
- Changing Cargo profiles or incremental compilation outside `watch:all`.

## Related files

- [Decision: disk-saving native watch builds](../docs/decisions/0005-watch-all-cargo-disk.md)

- `scripts/pix-watch`
- `tests/pix-watch.test.ts`
- `scripts/watch-all.mjs`
- `scripts/watch-all-desktop-quit.mjs`
- `tests/watch-all-desktop-quit.test.ts`
- `scripts/watch-all-state.mjs`
- `tests/watch-all-state.test.ts`
- `desktop/src/app/desktop-watch-restart.test.ts`
- `scripts/watch-all-temp.mjs`
- `tests/watch-all.test.ts`
- `desktop/src/app/desktop-watch-restart.svelte.ts`
- `desktop/src/App.svelte`
- `desktop/src/components/DesktopTitlebar.svelte`
- `desktop/src-tauri/build.rs`
- `desktop/src-tauri/src/lib.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/vite.config.ts`

## Verification

- `tests/watch-all-desktop-quit.test.ts` covers exact-PID targeting, clean-exit
  ordering, already-exited apps, refused Quit, timeout, and launcher retention
  on failure without operating a real Desktop instance.
- `tests/watch-all-state.test.ts` covers the progress schema, serialized state
  publication, failed-write recovery, failed-build recovery, and edits queued
  during an active build without launching real processes. Desktop's
  `desktop/src/app/desktop-watch-restart.test.ts` covers status polling,
  non-overlap, and ignored late completion after teardown; native parser tests
  cover legacy state and the four allowed progress values.
- `tests/pix-watch.test.ts` uses a fake npm (never the real watcher) to verify
  global symlink resolution, launch from an unrelated directory, argument
  forwarding, and exit-status propagation.
- `tests/watch-all.test.ts` covers the ordered `web -> native` build plan, the bounded watcher-state handoff, and the Tauri CLI override that suppresses the duplicate `beforeBuildCommand`.
- It also verifies that initial and repeated native watch builds use the same
  disk-saving Cargo environment and package-only cleanup before build/capture,
  without applying them to the web build, and abort on cleanup failure.
- `tests/watch-all.test.ts` also covers bounded failed-command output retention
  and the repeated bottom-of-terminal failure report, plus exact app-PID
  liveness checks used by the macOS startup gate, artifact retention and stale
  root reclamation with concurrent watcher and surviving app scenarios. It also
  covers reflog parsing, Git integration filtering, changed-part recovery after
  a missed bulk checkout event, duplicate suppression, and the conservative
  full-rebuild fallback when the Git diff probe fails.
- After changing/rebuilding Desktop web output, the subsequent native build must rerun the `pix-desktop` build script and produce a launchable bundle with `index.html` embedded.
- Run `node --import tsx --test tests/watch-all.test.ts`, `npm --prefix desktop run check`, and a production Desktop web/native smoke build.
