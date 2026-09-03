# Pix Desktop

Lightweight Tauri 2 + Svelte 5 client for Pix. It runs `pix-acp` as an
isolated child process and communicates with it over ACP JSON-RPC.

## Visual direction

The desktop client follows the terminal renderer's information hierarchy:
project-scoped sessions are horizontal tabs, the transcript remains visually
uninterrupted, thinking and tool activity stay compact, and model, thinking,
connection, and workspace controls live in the bottom status area. Native
desktop controls remain available without turning the interface into a
sidebar-and-chat-bubble layout.

## Local setup

From the repository root:

```sh
npm --prefix acp install
npm --prefix desktop install
npm run dev:desktop
```

`dev` and `build` compile `acp/dist/main.js` before Tauri starts. The current
MVP expects `node` to be available on `PATH`; pix-acp resolves pi's bundled RPC
entry from its pinned npm dependency. Packaging Node and pix-acp as a signed
sidecar is intentionally deferred.

For non-standard development setups, set `PIX_ACP_NODE_BINARY` to the Node
executable and/or `PIX_ACP_ENTRY` to a built pix-acp entry point.

## macOS title bar quirks

The project selector lives in a custom title bar (`ProjectTitlebar.svelte`,
36px tall) rendered under `titleBarStyle: "Overlay"` + `hiddenTitle`. Two
Tauri 2/macOS traps are easy to reintroduce:

- **Window dragging stops working.** `data-tauri-drag-region` sends the
  `window.start_dragging` IPC, which is *not* part of `core:window:default`
  (and therefore not part of `core:default`). The capability set in
  `src-tauri/capabilities/default.json` must explicitly include
  `core:window:allow-start-dragging` (plus
  `core:window:allow-internal-toggle-maximize` if double-click-to-zoom on the
  title bar should keep working). Without the permission the drag silently
  does nothing — there is no visible error in the UI.
- **Traffic lights render 4px higher than configured.** macOS draws the
  12px traffic-light dots 4px above the `trafficLightPosition` frame origin
  (NSButton frame inset). With a 36px header, `y: 16` puts the visible dots
  at y 12..24, centered on the row; `y: 12` makes them sit 4px too high and
  misaligned with the selector. If the header height changes, recompute as
  `y = (headerHeight - 12) / 2 + 4`.

Verification recipe (real window, macOS): see `.pi/skills/tauri-window-qa`;
measure the dot bounds from a screenshot (red/green pixel scan) and compare
with the header row border; drag via a CGEvent mouse-down/move/up sequence on
empty header space and confirm the window position changes while the content
area stays inert.

## Checks

```sh
npm --prefix desktop run check
npm --prefix desktop test
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```
