# Pix

Pix is a custom terminal UI for the Pi coding agent. It is built on the `@earendil-works/pi-coding-agent` SDK and provides its own renderer, input loop, session tabs, tool output controls, extension UI surface, and local voice input.

The npm package is currently named `pi-ui-extend` and installs the `pix` CLI.

## Highlights

- SDK-first Pi runtime integration; Pix does not use Pi's built-in `InteractiveMode`.
- Custom terminal renderer with streaming assistant output, thinking streams, tool rows, scrollback, and clickable tool expand/collapse state.
- Workspace-scoped session tabs and persistent Pi sessions.
- Local shell helpers through `!command` and raw TTY commands through `!!command`.
- Optional local Vosk voice dictation with Russian and English models.
- Pix extension UI helpers for toasts, menus, and rows above the input editor.
- Bundled `pi-tools-suite` payload. On startup, Pix links it into Pi's standard user extension directory.

## Requirements

- Node.js `24.x` (`24.16.0` is pinned for development).
- A terminal with good Unicode support. JetBrainsMono Nerd Font is recommended for the default icon theme.
- Optional for voice input: SoX (`rec`/`sox`), `ffmpeg`, or Linux `arecord`.

Development uses `mise` when available. `.node-version` and `.nvmrc` are also provided for other Node version managers.

## Installation

After publication, install Pix globally from npm:

```bash
npm install -g pi-ui-extend --ignore-scripts
```

The published package contains built JavaScript, the `pix` launcher, renderer extensions, documentation, and the bundled `pi-tools-suite` extension payload. Users do not need to clone the repository or build TypeScript locally.

On startup, Pix ensures the bundled suite is available at:

```text
~/.pi/agent/extensions/pi-tools-suite
```

If that path already contains a real directory, Pix leaves it untouched. If it is a Pix-managed symlink, Pix refreshes it as needed.

## Quick start

```bash
pix --cwd /path/to/workspace
```

If `--cwd` is omitted, Pix uses the current directory as the agent workspace.

Useful flags:

- `--cwd <path>`: workspace used for Pi tools, settings, resources, and sessions.
- `--no-session`: run with an in-memory SDK session.
- `--model <provider/model[:thinking]>`: request a specific model, for example `anthropic/claude-sonnet-4-20250514:medium`.
- `--reload-on-build`: restart the running Pix process after a successful watcher build.

## Updating Pix

Inside Pix, run:

```text
/update
```

This checks the currently installed package version without mutating the running process.

From a shell:

```bash
pix update --check  # check only
pix update          # update a package-manager install
pix update --force  # reinstall even when the check cannot prove an update is needed
```

`pix update` updates the Pix npm package, pinned Pi SDK dependencies, renderer-owned extensions, and the bundled `pi-tools-suite` payload. The next Pix startup refreshes the extension link in `~/.pi/agent/extensions/pi-tools-suite`.

Update checks respect:

- `PI_OFFLINE=1`
- `PI_SKIP_VERSION_CHECK=1`
- `PIX_SKIP_VERSION_CHECK=1`

Pi packages managed separately by Pi still use Pi's package manager:

```bash
pi update --extensions
# or
pi update
```

## Local development

Install dependencies:

```bash
npm install --ignore-scripts
```

Link the local `pix` command:

```bash
npm run link:pix
```

Run Pix against a workspace:

```bash
pix --cwd /path/to/workspace
```

During UI development, run the watcher in another terminal:

```bash
npm run watch:pix
```

Each running instance can reload after successful builds:

```bash
PIX_RELOAD_ON_BUILD=1 pix --cwd /path/to/workspace
# or
pix --reload-on-build --cwd /path/to/workspace
```

For a one-shot dev launch that rebuilds and refreshes the global link first:

```bash
npm run dev -- --cwd /path/to/workspace
```

Before committing code changes, run:

```bash
npm run check
```

## Configuration

Useful environment variables:

- `PIX_DISABLE_TERMINAL_OUTPUT_BUFFER=1` or `PIX_TERMINAL_OUTPUT_BUFFER=0`: disable Pix terminal output region buffering.
- `PIX_USE_FALLBACK_ICONS=1` or `PIX_ICON_THEME=fallback`: use plain fallback icons when Nerd Font glyphs are unavailable.
- `PIX_ICON_THEME=nerdFont`: force the Nerd Font icon theme.
- `PIX_ANTIGRAVITY_GOOGLE_CLIENT_ID` / `ANTIGRAVITY_GOOGLE_CLIENT_ID`: Google OAuth client ID used for Antigravity quota/login integrations.
- `PIX_ANTIGRAVITY_GOOGLE_CLIENT_SECRET` / `ANTIGRAVITY_GOOGLE_CLIENT_SECRET`: Google OAuth client secret used for Antigravity quota/login integrations.

Pix user configuration is read from:

```text
~/.config/pi/pix.jsonc
```

Example fallback icon configuration:

```jsonc
{
  "iconTheme": "fallback"
}
```

## Controls

- `Enter`: submit the prompt.
- `!command`: run a local shell command in an in-chat ephemeral block. Output is visible only in the local UI and is not saved to the SDK session.
- While a `!command` shell is running: `Enter` sends editor text to shell stdin; `Ctrl+C` interrupts the shell process.
- `!!command`: run a shell command in the raw interactive terminal for full-screen or TTY programs.
- `Ctrl+C`: exit Pix, or abort the running agent first.
- `Ctrl+D`: exit when the input line is empty.
- `Ctrl+L`: redraw.
- `Ctrl+G`: start or stop local Vosk voice input.
- `PageUp` / `PageDown`: scroll the conversation.
- Mouse wheel: scroll the conversation.
- Click a tool row: expand or collapse that tool result.
- Click the right-aligned microphone/language status widget: toggle voice input and switch Russian/English dictation.

## Voice input

Pix can dictate into the prompt through local Vosk. The first start for each language downloads the small model into the gitignored `models/vosk/` directory inside this project:

- Russian: `vosk-model-small-ru-0.22`
- English: `vosk-model-small-en-us-0.15`

Runtime requirements:

- Optional npm package `vosk`. Pix installs or rebuilds it automatically with scripts enabled on first voice start if the native binding is missing.
- A local recorder: SoX (`rec`/`sox`) preferred, or `ffmpeg`; Linux also supports `arecord`.
- JetBrainsMono Nerd Font for default app icons. On macOS, Pix checks this at startup and can install the Homebrew cask `font-jetbrains-mono-nerd-font` when it is missing.

If your terminal renders missing glyphs, start Pix with `PIX_USE_FALLBACK_ICONS=1` or set `iconTheme` to `fallback` in `~/.config/pi/pix.jsonc`.

## Pix extension SDK

Pix exposes a small SDK surface for extensions that need renderer-specific UI features. Import types and helpers from `pi-ui-extend/sdk`:

```ts
import type {
  ExtensionWidgetFactory,
  PixExtensionUIContext,
  PixMenuItem,
  ToastKind,
  ToastNotifier,
} from "pi-ui-extend/sdk";
import { TOAST_KINDS, isToastKind } from "pi-ui-extend/sdk";
```

The same public entrypoint is also exported from `pi-ui-extend`, but `pi-ui-extend/sdk` is the preferred explicit import path for extension-facing APIs.

### Toasts

Pix toasts are stackable by design: showing a new toast does not replace existing visible toasts. Each toast auto-hides independently after the renderer timeout.

Supported toast kinds:

- `success`
- `error`
- `warning`
- `info`

Use `ctx.ui.toast` from a Pix extension UI context:

```ts
export async function activate(ctx: { ui: PixExtensionUIContext }) {
  ctx.ui.toast.success("Saved");
  ctx.ui.toast.error("Build failed");
  ctx.ui.toast.warning("Using fallback model");
  ctx.ui.toast.info("Index refreshed");

  ctx.ui.toast.show("Custom message", "success");
}
```

`ctx.ui.notify(message, kind)` also maps to Pix toasts and accepts the same `ToastKind` values:

```ts
ctx.ui.notify("Retry succeeded", "success");
ctx.ui.notify("Check config", "warning");
```

### Rendering above the input

Use `ctx.ui.aboveInput` to render extension-controlled rows above the prompt editor, in the same area where Pix shows built-in todo and subagents panels.

```ts
ctx.ui.aboveInput.set("my-extension/status", [
  "My extension is watching files",
  "Press /my-command for details",
]);

ctx.ui.aboveInput.clear("my-extension/status");
```

For dynamic content, pass a widget factory. It receives a `WidgetTuiHandle` with `requestRender()`, `showToast()`, `toast`, `showMenu()`, and `menu` helpers, plus the current theme.

```ts
const widget: ExtensionWidgetFactory = (tui) => ({
  render: () => ["Dynamic extension row"],
  invalidate: () => tui.requestRender(),
});

ctx.ui.renderAboveInput("my-extension/dynamic", widget);
```

The lower-level `ctx.ui.setWidget(key, content, { placement })` API is still available. `aboveInput` is the preferred Pix SDK wrapper for rows above the input. Use `placement: "belowEditor"` only when you explicitly need rows below the prompt editor.

### Menus

Use `ctx.ui.menu.show()` or `ctx.ui.showMenu()` to open a Pix popup menu. The promise resolves to the selected item value, or `undefined` when the menu is cancelled.

```ts
const choice = await ctx.ui.menu.show<string>([
  { value: "copy", label: "Copy", description: "Copy result" },
  { value: "open", label: "Open", description: "Open in editor" },
  { value: "delete", label: "Delete", description: "Remove item", variant: "error" },
], {
  title: "Choose an action",
  placeholder: "Filter actions",
});

if (choice === "copy") ctx.ui.toast.success("Copied");
```

Menu items are searchable by label and `keywords` by default. Pass `searchable: false` to disable filtering. `ctx.ui.select(title, options)` is implemented on top of the same Pix menu renderer for simple string choices.

## Release process

Maintainers publish a new npm version with:

```bash
npm run publish-npm          # patch release
npm run publish-npm -- minor # minor release
npm run publish-npm -- major # major release
```

The publish command requires a clean `master`, runs release checks, bumps the root package version, smoke-tests the packed tarball, and pushes the release tag. GitHub Actions publishes tagged releases to npm using the `NPM_TOKEN` repository secret.

For the full release checklist, see [docs/release.md](docs/release.md).

## Current limitations

Pix is actively evolving. Known gaps include:

- Text selection/copy support in the custom renderer.
- Full prompt editor parity with mature terminal editors.
- Dedicated session picker/fork UI.
- Dedicated model picker UI.
- Extension dialog rendering beyond SDK defaults.
