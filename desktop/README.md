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

## Checks

```sh
npm --prefix desktop run check
npm --prefix desktop test
cargo check --manifest-path desktop/src-tauri/Cargo.toml
```
