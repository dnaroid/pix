# 0030 — Default-on suite codemode alongside direct tools

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested suite-config and Desktop controls,
  then selected default-on alongside ordinary tools in this conversation.
- Governing spec: [Suite codemode](../../specs/suite-codemode.md)
- Replaces / replaced by: none

## Context

SDK 1.0.2 supplies QuickJS codemode, but Pix SDK sessions did not register or
activate it. The feature should use existing suite module configuration and
Desktop settings rather than introduce a second enablement source.

## Observations and sources

- Installed SDK `docs/codemode.md` and `dist/extensions/codemode/index.js` expose
  `createCodemodeExtension`; the CLI registers a builtin while SDK hosts must
  register it themselves. The factory only registers a default-inactive tool.
- The suite catalog already drives runtime modules and the Desktop checklist;
  [Desktop config editing](../../specs/desktop-user-config-editing.md) explicitly
  excludes hot-applying saved settings to running consumers.
- SDK nested execution goes through tool hooks and abort signals. Focused
  installed-SDK tests are the verification source, not an assumed permission bypass.

## Decision

Add a default-on `codemode` module. At session start reuse a registered definition
or register the SDK implementation in additive `on` mode, then append it to the
active set. Skip restricted-selection environments used by children. Reuse the
existing `modules.codemode` precedence and Desktop checklist. Module opt-out
disables the suite contribution, not independently configured host functionality.

## Alternatives

- Default off: not the user's selected behavior.
- `only` mode: hides direct declarations, contrary to the chosen additive mode.
- Always register at factory load: risks conflicting with CLI builtins; defer
  until the complete tool registry is available instead.
- Separate Desktop/suite boolean: duplicates existing module enablement.

## Consequences

One config switch covers Pix TUI and Desktop; the existing SDK handles sandbox
and execution lifecycle. Direct tool use remains available. Another model-facing
tool adds prompt cost; no latency or quality improvement is claimed. Existing
CLI definitions retain their own mode, and settings need reload/restart.

## Revisit when

SDK changes runtime registration/exposure, child permission policy changes, or
measurements justify a different default or dedicated codemode tuning UI.
