# 0005 — Disk-saving native watch builds

- Status: accepted
- Recorded: 2026-10-02
- Decided: 2026-10-02
- Owner / approval evidence: parent implementation decision for the user's
  request to fix `watch:all` after clearing an oversized native target directory.
- Governing spec: [watch:all Desktop assets](../../specs/watch-all-desktop-assets.md)
- Replaces / replaced by: none

## Context

Desktop web edits trigger native rebuilds to embed the newest assets. The watch
loop should retain dependency reuse without the disk cost of incremental state
and full native debug symbols.

## Observations and sources

- The user reported excessive disk consumption in `desktop/src-tauri/target`
  and had already cleared it. No before-cleanup size breakdown is available;
  the exact contribution of each artifact category is not established.
- [The watcher](../../scripts/watch-all.mjs) has a dedicated persistent
  `target/watch-all` directory and uses Tauri's debug build mode. Previously it
  passed only `CARGO_TARGET_DIR`, leaving incremental/debug settings unchanged.
- [Tests](../../tests/watch-all.test.ts) verify consistent subprocess settings
  across initial and repeated builds, and their isolation from web builds.
- Locally installed `tauri-codegen` 2.6.3, `src/embedded_assets.rs`, writes assets
  under `OUT_DIR` using content-hashed filenames and reuses existing entries;
  that path does not remove superseded assets. This establishes an accumulation
  mechanism, not its measured contribution to the user's cleared target.

## Decision

Set `CARGO_INCREMENTAL=0` and `CARGO_PROFILE_DEV_DEBUG=0` for every native watch
subprocess, overriding inherited values. Retain the existing target directory,
debug-mode behavior, compiled dependency cache, and artifact/restart lifecycle.
Do not change Cargo.toml or ordinary native/release builds.

Before every native watch build, use Cargo's package-scoped clean for
`pix-desktop`, explicitly targeting only `target/watch-all`. Cargo handles the
build-directory lock; clearing this crate's outputs removes previous embedded
asset hashes without deleting dependency artifacts or the separately copied
running application. Cleanup failure aborts that build cycle.

## Alternatives

- Clean the entire target or directly delete directories: forces expensive
  dependency rebuilds or bypasses Cargo's lock. Package-scoped Cargo cleanup
  avoids both problems.
- Only disable incremental/debug info: reduces size but does not reclaim
  content-hashed assets retained by Tauri codegen.
- Disable incremental compilation only for web-triggered builds: switching
  settings within one cache undermines reuse and leaves native-only watch
  sessions producing the expensive state.
- Change the global dev profile: unnecessarily changes non-watch debugging.

## Consequences

Expected lower steady-state disk usage, not a hard size quota. Rust edits may
compile more slowly without incremental state; the application crate is always
rebuilt after cleanup, while dependencies remain reusable. Native source-level debugging
requires a normal non-watch debug build. Dependency/toolchain changes can still
leave obsolete dependency artifacts; other target directories are not reclaimed.

## Revisit when

Target continues growing across same-profile web rebuilds, native rebuild times
become unacceptable, or watch-mode source-level debugging becomes a requirement.
