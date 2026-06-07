# pix-tui (Rust)

Experimental Rust port of the Pix terminal UI. It lives in `apps/tui-rust/` as a standalone Cargo crate and currently reuses the existing Node sidecar instead of reimplementing the Pi SDK bridge in Rust.

## Architecture

```text
┌──────────────────┐    JSONL over stdio    ┌──────────────────────────────┐
│   pix-tui (Rust) │ ─────────────────────▶ │  pix-desktop-sidecar (Node)  │
│  ratatui+tokio   │ ◀───────────────────── │  wraps pi-coding-agent SDK   │
└──────────────────┘   responses + events   └──────────────────────────────┘
```

Protocol notes:

- Commands: `{id?, type, ...}`
- Responses: `{id?, type:"response", command, success, data? | error?}`
- Events: forwarded sidecar/session events plus extension UI events

The sidecar entrypoint is expected at `apps/desktop-tauri/sidecar/dist/main.js` unless overridden with `PIX_SIDECAR_PATH`.

## Prerequisites

- Rust stable toolchain
- Node.js with the sidecar dependencies installed
- Built sidecar dist at `apps/desktop-tauri/sidecar/dist/main.js`

## Build

From the repo root:

```bash
npm install --ignore-scripts
npm run check
npm --prefix apps/desktop-tauri/sidecar run build
cargo build --manifest-path apps/tui-rust/Cargo.toml --locked
```

Release build:

```bash
cargo build --manifest-path apps/tui-rust/Cargo.toml --release --locked
```

## Run

From the repo root:

```bash
# Print setup diagnostics first if you are not sure the sidecar/config paths are correct.
cargo run --manifest-path apps/tui-rust/Cargo.toml -- --diagnostics

# Run against the current workspace.
cargo run --manifest-path apps/tui-rust/Cargo.toml -- --cwd .

# Ephemeral session, no persistence.
cargo run --manifest-path apps/tui-rust/Cargo.toml -- --no-session --cwd /path/to/workspace
```

After building a release binary, you can install it locally with Cargo:

```bash
cargo install --path apps/tui-rust --locked
pix-tui --diagnostics
pix-tui --cwd /path/to/workspace
```

`cargo install --path apps/tui-rust` only installs the Rust binary. The binary still needs access to a built Node sidecar, either in this repo at `apps/desktop-tauri/sidecar/dist/main.js` or through `PIX_SIDECAR_PATH=/absolute/path/to/main.js`.

## Runtime diagnostics and crash reports

- `pix-tui --diagnostics` prints the resolved sidecar path, config candidates, crash-report directory, selected session mode, argv, and relevant environment overrides.
- Panic/crash reports are written to a user-local crash-report directory:
  - default: platform-local app data under `pix-tui/crash-reports`
  - override: `PIX_TUI_CRASH_DIR=/path/to/reports`
- Set `RUST_BACKTRACE=1` when reproducing a crash to include the Rust backtrace in terminal output as well as the saved report.

If the UI crashes while raw mode is active, `pix-tui` now makes a best effort to restore the terminal before printing the crash path.

## Troubleshooting

Common setup failures:

- `failed to locate pix-desktop-sidecar`:
  - run `npm --prefix apps/desktop-tauri/sidecar run build`
  - or set `PIX_SIDECAR_PATH=/absolute/path/to/main.js`
- `failed to spawn sidecar`: ensure Node.js is installed and available on `PATH`, or point `PIX_SIDECAR_NODE` at a specific Node executable.
- blank/messed-up terminal after a crash: run `reset` or reopen the terminal, then check the newest file in the crash-report directory from `pix-tui --diagnostics`.

Useful commands while debugging:

```bash
pix-tui --diagnostics
RUST_BACKTRACE=1 pix-tui --cwd /path/to/workspace
PIX_SIDECAR_PATH=/absolute/path/to/main.js pix-tui --cwd /path/to/workspace
```

## Packaging status

There is no standalone installer yet. Current release-friendly artifacts are:

- `target/release/pix-tui`
- the built sidecar dist in `apps/desktop-tauri/sidecar/dist/`
- this README and the root repo docs

For now, prefer Cargo installs or shipping the release binary alongside the built sidecar assets instead of attempting per-platform installer logic in this repo. Treat the Rust binary and the built sidecar dist as one runtime bundle.

## Current slice

- Bottom: multi-line input box
- Center: scrolling conversation area (user/assistant/tool/diagnostic blocks)
- Top: status line (model / session id / streaming / bridge state)

Current milestone status: practical vertical slice plus M3 groundwork for diagnostics, crash reporting, and release documentation.
