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

To run the watcher from any directory without keeping an editor open, install
the development launcher once from the repository root:

```bash
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/scripts/pix-watch" "$HOME/.local/bin/pix-watch"
```

Ensure `$HOME/.local/bin` is on `PATH`, then run `pix-watch` in a terminal.
It runs `npm run watch:all` in the linked checkout using npm from `PATH`.
Keep that terminal open; stop with `Ctrl+C`. This is not a background service.
If you move the checkout, recreate the symlink.

### Native QA without restarting your working Desktop

Prepare/check the native automation helper independently of the watcher:

```bash
npm run qa:desktop -- doctor
```

Development installs the signature-checked helper at the permanent OS-account
path `~/Library/Application Support/Pix/ui-qa/helpers/macos-accessibility`.
This is user-global, not a system-wide/root install: all checkouts share it, and
Registry Clean, `.pi/subagents` cleanup and temporary QA HOME do not remove or
relocate it. A matching private old project helper is copied and verified without
re-signing; the legacy copy is left for ordinary cleanup, not used by new runs.
Source changes are built privately and published under the shared build lock.
Installed releases still use their signed payload helper, not this dev install.

To explicitly request permissions:

```bash
npm run qa:desktop -- doctor --prompt
```

This requests Accessibility and Screen Recording for the helper whose full path
is printed; it does not launch/restart Desktop, start a watcher, grant permission
or reset TCC. Approve that helper in **System Settings > Privacy & Security**,
under **Accessibility** and **Screen Recording**. Pix Desktop's own permission
does not imply permission for the helper. If no dialog appears, add/enable the
exact printed executable manually. Rerun plain `doctor` after approval in a new
process: exit 0 means both grants are present, 2 means at least one is missing,
and 1 means setup/diagnosis failed. `--prompt` may return 2 before approval.

Permanent storage prevents cleanup from deleting the helper, but does not
guarantee permanent macOS grants. Moving the executable or changing its signing
identity may require approval again. Ad-hoc source rebuilds change the
code-hash-based identity; `PI_UI_QA_MACOS_CODESIGN_IDENTITY` can select an existing
keychain signing certificate for a stable certificate-based requirement.
Do not silently create certificates or change OS privacy settings from `ui-qa`.

With the existing `watch:all` running, prepare an isolated test copy:

```bash
npm run qa:desktop -- prepare
```

Use its returned manifest path with
`npm run qa:desktop -- launch --manifest <manifestPath>` for a manual launch.
The `ui-qa` subagent instead gives the unified runner a direct project-script
launch target; `.pi/skills/pix-desktop-qa/SKILL.md` contains that workflow.
The test copy has its own HOME, agent sessions, application state, ephemeral
WebView and disposable project; your working app stays on its current build.

Preparation waits for the successful watcher artifact and never starts another
watcher. Use `--state <desktop-watch-state.json>` to disambiguate watchers and
`--timeout-ms <100..300000>` for a bounded wait. For authorized model-based tests,
`--seed-config --seed-api-keys` explicitly copies allowlisted settings and literal
API keys only; it does not copy OAuth tokens, sessions or an entire home. Do not
export the private profile with screenshots. UI-only tests need no credentials.
See `specs/desktop-qa-isolated-launch.md` for identity, cleanup and failure rules.

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
