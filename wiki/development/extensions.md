# Extension authors

<!-- markdownlint-disable MD013 -->

Pix runs on the Pi SDK and exposes a renderer-facing UI context for extensions.
It is not a separate agent protocol that requires extensions to abandon Pi's
session/tool model.

## SDK entry points

```ts
import type { PixExtensionUIContext } from "pi-ui-extend";
// or
import type { PixExtensionUIContext } from "pi-ui-extend/sdk";
```

Published declarations are generated at:

```text
dist/sdk.d.ts
```

## UI surface

Pix implements the Pi extension UI surface used for:

- notifications and keyed toasts;
- widgets and content above the input;
- menus and dialogs;
- custom full-screen UI;
- editor text;
- terminal input hooks;
- theme helpers;
- status updates.

Extensions should use public Pi/Pix SDK contracts rather than assuming stock
renderer internals.

When the same extension can run without an interactive renderer, protect UI-only
paths with `ctx.hasUI`.

## Bundled extensions

The bundled [pi-tools-suite](../tools/suite.md) is a useful
reference for extensions that need to work in Pix while remaining usable in
other Pi contexts. Suite-spawned sub-agents intentionally use a smaller isolated
extension set rather than inheriting the complete parent UI environment.

Pix also bundles the TUI-only `choice-actions` extension. It advertises optional
next-step checklists in the system prompt and presents valid `pix-actions`
blocks from the final assistant message as a selectable widget above the editor.
The shared contract and Desktop behavior are documented in the
[HTML Sandbox specification](../desktop/rendering/desktop-html-sandbox.md#quick-choice-actions).

## Development

See [Development](guide.md) for the source checkout and build/test
commands. Renderer/SDK behavior changes should be tested against the public
extension contract rather than only against one visual path.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"de8f046f6b235a9754ee7f23aa94e834b65b614fca3b2e7d2d3e1a74ac5e28e8","checkedAt":"2026-10-30T23:20:05.881Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":56,"reportLanguage":"ru"} -->
