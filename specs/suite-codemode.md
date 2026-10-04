---
kind: spec
status: active
---

# Suite codemode

## Behavior

The `codemode` suite module is enabled by default. On session start it adds the
SDK's QuickJS JavaScript tool to the active tool set without removing direct
tools. Pix SDK hosts register `createCodemodeExtension({ mode: "on" })` when the
tool is absent; hosts such as the Pi CLI reuse their existing definition.
Model-specific tool profile changes preserve this non-managed tool.

The shared module catalog exposes `codemode` in Desktop **Settings → Tools Suite
→ General → Modules** with its default and description. The checkbox writes
`modules.codemode` in the shared user `pi-tools-suite.jsonc`. For example,
`{ "modules": { "codemode": false } }` disables suite registration/activation.
Existing list/map aliases, project overrides and environment precedence apply.
Changes require extension reload or session restart; saving settings does not
modify the running session. Existing configs need no migration.

SDK scripts use QuickJS, not a Node shell. They can call exposed session tools;
nested calls retain SDK validation, safety hooks and cancellation. They emit
execution events and bounded metadata on the parent result, not independent
transcript tool-result messages. The SDK owns VM limits and script-state storage.

## Constraints and failure cases

- Do not widen explicit restricted selections: if either
  `PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION` or its legacy
  `MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION` alias is truthy, the module does not
  register or activate anything. This protects suite async-subagent profiles.
- Disabling this module removes only the suite's contribution. It is not a hard
  deny against a host, MCP integration or other extension independently enabling
  codemode. Existing host definitions and settings (including a CLI's explicit
  `codemode.mode: "only"`) are not overwritten.
- QuickJS is not a security boundary against tool permissions: tools still run
  with their host permissions. Inactive direct tools are not callable from scripts;
  SDK `codemode`/`deferred` exposure retains its upstream semantics.
- No new model routing policy, custom renderer, MCP setup or live config watcher.

## Implementation

- `external/pi-tools-suite/src/codemode/index.ts`
- `external/pi-tools-suite/src/module-catalog.ts`
- `external/pi-tools-suite/src/default-pi-tools-suite-config.ts`
- `external/pi-tools-suite/src/config.ts`
- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsModuleVisibility.svelte`
- `desktop/src/lib/tools-suite-module-visibility.ts`

## Tests

- `external/pi-tools-suite/test/codemode.test.ts`
- `external/pi-tools-suite/test/codemode-sdk.test.ts`
- `external/pi-tools-suite/test/evals/extension-contracts.test.ts`
- `external/pi-tools-suite/test/evals/coverage-manifest.ts`
- `desktop/src/lib/tools-suite-module-visibility.test.ts`

## Verification

Run suite typecheck and focused codemode/config/model-tools/eval-contract tests;
run Desktop module-visibility tests and checks. Real installed-SDK tests exercise
QuickJS, additive declarations, CLI reuse, nested hook blocking and cancellation
without paid model calls. In native Desktop check the default row and saved
off/on JSONC round trip. Sync the live suite after verification.

## Related

- [Default-on integration decision](../docs/decisions/0030-suite-codemode.md)
- [Desktop config editing](desktop-user-config-editing.md)
