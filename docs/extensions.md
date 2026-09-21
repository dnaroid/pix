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

The bundled [pi-tools-suite](../external/pi-tools-suite/README.md) is a useful
reference for extensions that need to work in Pix while remaining usable in
other Pi contexts. Suite-spawned sub-agents intentionally use a smaller isolated
extension set rather than inheriting the complete parent UI environment.

## Development

See [Development](development.md) for the source checkout and build/test
commands. Renderer/SDK behavior changes should be tested against the public
extension contract rather than only against one visual path.
