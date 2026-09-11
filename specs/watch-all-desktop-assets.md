# watch:all Desktop web asset embedding

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Keep the Desktop process launched by `npm run watch:all` on the latest successfully built Vite bundle instead of allowing Cargo incremental state to retain stale or missing embedded Tauri assets.

## Behavior

- A Desktop web-source change schedules `web` followed by `native`; the running Desktop is replaced only after both steps succeed.
- `watch:all` disables Tauri's `beforeBuildCommand` because it has already built the web bundle once in the ordered build plan.
- `desktop/src-tauri/build.rs` explicitly tracks `../dist/index.html` as a Cargo input. Vite's production entrypoint contains hashed references to the emitted JS/CSS assets, so a successful web rebuild invalidates the native crate even when no Rust source changed.
- The native rebuild therefore regenerates and recompiles Tauri's embedded asset context before the newly bundled Desktop is launched.
- A failed web/native build keeps the previous working Desktop process alive; the watcher never restarts into a partially built frontend.
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
- `desktop/src-tauri/build.rs`
- `desktop/src-tauri/tauri.conf.json`
- `desktop/vite.config.ts`

## Verification

- `tests/watch-all.test.ts` covers the ordered `web -> native` build plan and the Tauri CLI override that suppresses the duplicate `beforeBuildCommand`.
- `tests/watch-all.test.ts` also covers bounded failed-command output retention
  and the repeated bottom-of-terminal failure report.
- After changing/rebuilding Desktop web output, the subsequent native build must rerun the `pix-desktop` build script and produce a launchable bundle with `index.html` embedded.
- Run `npm run test:inner -- --test-name-pattern='watch:all'`, `npm --prefix desktop run check`, and a production Desktop web/native smoke build.
