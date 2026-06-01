# Local pi-lsp fork

This directory is a local Pi auto-discovered fork of the `pi-lsp` npm package.

Why it exists:

- the published `pi-lsp@0.1.7` did not refresh diagnostics after this harness's `apply_patch` tool;
- direct edits under `~/.pi/agent/npm/node_modules/pi-lsp` are fragile and disappear on package reinstall/update;
- Pi auto-discovers `~/.pi/agent/extensions/*/index.ts`, so this fork is loaded from `~/.pi/agent/extensions/pi-lsp/index.ts`.

Local changes:

- `extensions/pi-lsp/index.ts` handles namespaced mutation tools such as `functions.apply_patch`;
- parses `apply_patch` bodies from raw string, `input`, `patch`, `text`, or `content` fields;
- refreshes diagnostics for every file in a multi-file patch;
- clears stale diagnostics before re-reading a changed file;
- waits synchronously for a fresh `textDocument/publishDiagnostics` notification
  for the changed document/version instead of returning after a fixed 1500ms
  sleep. The default maximum wait is 10000ms and can still be overridden per
  server with `diagnosticsWaitMs` in `~/.pi/agent/lsp.json` or project `.pi/lsp.json`;
- uses `typescript.tsserverRequest` as a synchronous diagnostics fallback for
  `typescript-language-server`, avoiding intermittent post-edit timeouts when
  the server does not publish fresh diagnostics within `diagnosticsWaitMs`.

Operational notes:

- `npm:pi-lsp` was removed from `~/.pi/agent/settings.json` to avoid duplicate tool registrations.
- The original npm package can remain under `~/.pi/agent/npm/node_modules/pi-lsp` as a source/backup, but it should not be listed in Pi settings while this fork is active.
- After editing this fork, restart Pi or run `/reload` for changes to load.
