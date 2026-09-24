# Development

<!-- markdownlint-disable MD013 -->

Use this guide for source development. End users should normally install a
self-contained [GitHub Release](installation.md).

## Requirements

- Node.js `>=22.19.0 <27`;
- npm selected by the current shell;
- Git;
- Rust + platform Tauri prerequisites for native Desktop builds.

Pix intentionally does not pin Node with mise/nvm/Volta repository files.
Development, CI and release scripts use the `node` / `npm` on `PATH`.

## Clone and install

```bash
git clone https://github.com/dnaroid/pix.git
cd pix

command -v node
node --version
command -v npm
npm --version

npm ci
```

ACP, Desktop and pi-tools-suite have their own dependency trees when their
commands are used:

```bash
npm ci --prefix acp
npm ci --prefix desktop
npm ci --prefix external/pi-tools-suite
```

After changing Node major versions, delete all native dependency trees before
reinstalling:

```bash
rm -rf node_modules acp/node_modules desktop/node_modules external/pi-tools-suite/node_modules
npm ci
npm ci --prefix acp
npm ci --prefix desktop
npm ci --prefix external/pi-tools-suite
```

This avoids reusing native addons built for a different Node ABI.

## TUI development

```bash
npm run dev -- --cwd /path/to/project
npm run check
npm run test:tools-suite
npm run build:pix
```

## Desktop development

```bash
npm run dev:desktop
npm run check:desktop
npm --prefix desktop test
```

`npm run watch:all` watches Pix, ACP, the bundled suite and Desktop. It keeps
the last working Desktop process alive while a replacement compiles and only
switches after the complete queued build succeeds. On macOS it prunes superseded
temporary `.app` copies after builds/restarts and safely reclaims abandoned
watcher temp roots at the next startup. Roots containing a running app or owned
by another watcher are retained; do not delete them while Desktop is active.

## Release builds

Release construction and native verification are intentionally separate from
development builds. See [Release and update verification](release.md).

Native release targets must be built on the corresponding native OS/CPU because
the packaged runtime contains native modules.

## README screenshots

Regenerate screenshots without live accounts/model traffic:

```bash
node --import tsx scripts/capture-readme-screenshots.ts
```

The capture harness uses the real renderer, an isolated temporary home and the
local test `MockModel`.

## Project layout

```text
src/                         Pix TUI renderer and SDK bridge
desktop/                     Pix Desktop Tauri/Svelte application
acp/                         ACP adapter embedding Pi for Desktop/editors
external/pi-tools-suite/     bundled tools/extensions
schemas/                     published JSON schemas
skills/                      packaged agent skills
docs/                        user/developer/release documentation
tests/                       TUI unit/integration/PTY tests
scripts/                     build, release, sync and capture tooling
```
