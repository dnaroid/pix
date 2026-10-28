# Architecture and component boundaries

Pix has terminal and native Desktop hosts around Pi sessions, plus an ACP adapter and bundled extensions. The pages here cover process, async/lifecycle and protocol boundaries; feature-specific internals remain with their feature.

[Wiki home](../index.md)

## Pages

- [pix-acp](acp.md)
- [Desktop connection lifecycle and bounded update replay](desktop-async-lifecycle.md) — active
- [Desktop native process lifecycle](desktop-native-process-lifecycle.md) — active
- [Desktop global operation lock audit](desktop-operation-lock-audit.md)
- [Bind session extensions before prompting](session-extension-bind-before-prompt.md)

## Components

- [Terminal application](../../src/app/) hosts project-scoped Pi sessions and the TUI.
- [Desktop frontend](../../desktop/src/) and [native shell](../../desktop/src-tauri/) implement the macOS workbench.
- [ACP adapter](acp.md) bridges the Desktop/client protocol to Pi session events and tools.
- [Bundled toolkit](../tools/suite.md) supplies project tools, agents and context management.
- Feature internals belong with [Desktop](../desktop/index.md), [search](../search/index.md),
  [context](../context/index.md) and [work management](../work-management/index.md), not duplicated here.
