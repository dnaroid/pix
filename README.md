# pi-ui-extend

SDK-first prototype for a custom pi terminal renderer.

This project intentionally does not use pi's built-in `InteractiveMode`. It creates an `AgentSessionRuntime` through the SDK, subscribes to agent events, and renders its own terminal UI with independent scroll and tool expansion state.

## Install

This project is pinned to Node 24.16.0. `mise` users get this from `.mise.toml`; `.node-version` and `.nvmrc` are also present for other version managers. The npm scripts and `pix` launcher re-exec through Node 24 so native Vosk bindings are not built under newer Node releases.

```bash
npm install --ignore-scripts
```

After publication, users can install the CLI globally:

```bash
npm install -g pi-ui-extend --ignore-scripts
```

The published package ships the built Pix renderer and a `pi-tools-suite` extension payload. On startup Pix links that suite into the standard user extension location (`~/.pi/agent/extensions/pi-tools-suite` on macOS/Linux), so users do not need to clone this repo or build from TypeScript.

## Run

```bash
npm run link:pix
pix --cwd /path/to/project
```

During local development, run the watcher in another terminal so the global `pix` command is rebuilt after source changes:

```bash
npm run watch:pix
```

For multiple live `pix` instances, enable per-instance reload. Each running instance will restart itself after `watch:pix` emits a successful build:

```bash
PIX_RELOAD_ON_BUILD=1 pix --cwd /path/to/project
# or:
pix --reload-on-build --cwd /path/to/project
```

Or run directly in dev mode; this also rebuilds and refreshes the global `pix` link once before starting:

```bash
npm run dev -- --cwd /path/to/project
```

If `--cwd` is omitted, the current working directory is used as the agent workspace.

Useful flags:

- `--cwd <path>`: workspace used by pi tools, resources, settings, and sessions
- `--no-session`: keep the SDK session in memory
- `--model <provider/model[:thinking]>`: request a specific model, e.g. `anthropic/claude-sonnet-4-20250514:medium`

Useful environment variables:

- `PIX_DISABLE_TERMINAL_OUTPUT_BUFFER=1`: disable Pix terminal output region buffering. `PIX_TERMINAL_OUTPUT_BUFFER=0` is also accepted.
- `PIX_USE_FALLBACK_ICONS=1` or `PIX_ICON_THEME=fallback`: use plain fallback icons when the Nerd Font icon glyphs are not available. `PIX_ICON_THEME=nerdFont` restores the icon-font theme.

## Updates

Use `/update` inside Pix to check the currently installed package version without mutating the running process. It reports the current Pix version, the latest npm version when reachable, and whether the installed package can self-update.

From a shell:

```bash
pix update --check  # check only
pix update          # update a package-manager install
pix update --force  # reinstall even if the check cannot prove an update is needed
```

`pix update` updates the Pix npm package, its pinned Pi SDK dependencies, renderer-owned extensions, and the `pi-tools-suite` payload. The next Pix startup refreshes the standard user extension link at `~/.pi/agent/extensions/pi-tools-suite`. Source checkouts should be updated with:

```bash
git pull && npm install --ignore-scripts && npm run build:pix && npm run link:pix
```

Pix respects `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, and `PIX_SKIP_VERSION_CHECK=1` for update checks. Pi packages installed separately through Pi settings still use Pi's own package manager: run `pi update --extensions` or `pi update` when you need to update those resources.

For release verification, see [docs/release.md](docs/release.md).

Maintainers publish a new npm version with:

```bash
npm run publish-npm          # patch release
npm run publish-npm -- minor # minor release
```

The command requires a clean `master`, bumps the root package version, smoke-tests the packed tarball, then pushes the release tag for GitHub Actions to publish.

## Controls

- `Enter`: submit prompt
- `!command`: run a local shell command in an in-chat ephemeral block; output is visible only in the local UI and is not saved to the SDK session
- while a `!command` shell is running: `Enter` sends the editor text to the shell stdin; `Ctrl+C` interrupts the shell process
- `!!command`: run a shell command in the raw interactive terminal for full-screen/TTY programs
- `Ctrl+C`: exit, or abort the running agent first
- `Ctrl+D`: exit when the input line is empty
- `Ctrl+L`: redraw
- `Ctrl+G`: start/stop local Vosk voice input
- `PageUp` / `PageDown`: scroll conversation
- mouse wheel: scroll conversation
- click a tool row: expand/collapse that tool result
- click the right-aligned `󰍬 RU` / `󰍬 EN` status widget: the Nerd Font microphone icon (`U+F036C`) toggles voice input, the language label switches Russian/English

## Voice input

Pix can dictate into the prompt through local Vosk. The first start for each language downloads the small Vosk model into `models/vosk/` inside this project (gitignored):

- Russian: `vosk-model-small-ru-0.22`
- English: `vosk-model-small-en-us-0.15`

Runtime requirements:

- optional npm package `vosk` (Pix installs/rebuilds it automatically with scripts enabled on first voice start if the native binding is missing; install progress is printed into the chat as `system:` messages)
- a local recorder: SoX (`rec`/`sox`) preferred, or `ffmpeg`; Linux also supports `arecord`
- JetBrainsMono Nerd Font for app icons. On macOS Pix checks this at startup and installs the Homebrew cask `font-jetbrains-mono-nerd-font` when it is missing. If the terminal still renders missing glyphs, start Pix with `PIX_USE_FALLBACK_ICONS=1` or set `{ "iconTheme": "fallback" }` in `~/.config/pi/pix.jsonc`.

## Pix SDK

Pix exposes a small SDK surface for extensions that want to use renderer-specific UI features. Import types and helpers from `pi-ui-extend/sdk`:

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

Use `ctx.ui.aboveInput` to render extension-controlled rows above the prompt editor, in the same area where Pix shows the built-in todo and subagents panels.

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

The lower-level `ctx.ui.setWidget(key, content, { placement })` API is still available; `aboveInput` is the preferred Pix SDK wrapper for rows above the input. Use `placement: "belowEditor"` only when you explicitly need rows below the prompt editor.

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

## Current scope

Implemented:

- SDK runtime bootstrap
- custom terminal event loop
- streaming assistant text
- thinking stream capture
- tool start/update/end rows
- independent scroll state
- clickable tool expand/collapse
- basic SGR mouse parsing

Not implemented yet:

- text selection/copy
- full prompt editor behavior
- session picker/fork UI
- model picker UI
- extension dialog rendering beyond SDK defaults
