# Desktop missing-LSP onboarding

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

When an agent creates or edits a source file for a language that has no
registered matching LSP, warn in the active conversation, pause safely on user
request, and offer a trusted automatic installation flow in a dedicated
workbench tab.

## Trigger

- Onboarding is driven by successful mutation tool results, not repository
  discovery or reads. `write`, `edit`, `apply_patch`, and `ast_apply` participate
  through the existing LSP mutation-path extractor.
- The changed path must exist after the mutation and map to a language in the
  trusted automatic-installer catalog.
- The LSP module loads the same effective LSP configuration used for diagnostics.
  If any enabled configured server can match the edited file by include/exclude
  rules, the language is considered registered and no onboarding warning is
  published. Root-marker availability and server startup health are intentionally
  not used to classify a server as missing: a configured-but-broken LSP is an
  operational error, not an installation suggestion.
- Initial automatic installers cover TypeScript/JavaScript, Svelte, Vue, Python,
  Go, Rust, and Ruby. Languages without a trusted installer remain unchanged
  until an explicit installer recipe is added.

## Desktop interaction

- The LSP extension publishes a private session-scoped
  `pi-tools-suite:lsp-missing` state event containing only a trusted installer
  identifier plus presentation metadata and the edited path.
- Desktop validates the installer identifier against its own allowlist before
  accepting the event.
- The active conversation shows one centered warning surface for the current
  project/language. Repeated mutation events update/dedupe the same suggestion
  rather than stacking toasts. **Not now** suppresses that project/language for
  the current Desktop workspace lifecycle.
- If the owning agent is running, the primary action is **Pause & install** and
  uses the existing turn-boundary pause request. It does not call Stop/cancel.
  The installation tab is not opened until the session actually reaches
  `paused`; if the run is already idle/paused, installation may start
  immediately.
- The LSP installer is a UI-only workbench tab anchored next to the conversation
  that triggered it. It is not an ACP/TUI session and is not persisted in the
  session-tab list.
- While installation is active the installer tab is not closable. It shows the
  selected server, progress, bounded install output, success/failure, and Retry
  after failure. Success/error states may be closed normally.
- Successful installation never continues the agent automatically. A paused
  conversation stays paused until the user explicitly chooses Continue.
- Only one pause/install pipeline is active at a time. Missing-LSP suggestions
  from other sessions may be retained, but they stay hidden until the current
  installation finishes so one installer tab cannot be overwritten by another.

## Trusted installation

- Desktop dispatches only hard-coded native installer IDs. No command text from
  the model, mutation result, file contents, or session-state notification is
  executed.
- Package-manager work runs in a blocking Tauri worker rather than the UI thread.
  Installed payloads use Pix-owned user locations where practical:
  `~/.local/share/pix/lsp/<id>/`.
- TypeScript/JavaScript, Svelte, and Vue use fixed npm package sets. Python uses
  a Pix-owned virtual environment. Go uses a Pix-owned `GOBIN`. Ruby uses a
  Pix-owned gem home. Rust uses the user's `rustup` component installation.
  Missing package-manager prerequisites fail visibly in the installer tab.
- After installation Desktop writes the fixed server template and returned
  executable path/env into the trusted user
  `~/.config/pi/pi-tools-suite.jsonc` LSP server list. JSONC comments and
  unrelated settings are preserved, an existing server with the same ID is
  replaced, and optimistic conflict checks retry before failing visibly.
- Project-local `.pi/pi-tools-suite.jsonc` trust semantics are unchanged.
  Installing an LSP does not auto-trust or rewrite project-local LSP commands.

## Lifecycle and concurrency

- Workspace changes clear pending warning/install UI state. A late native
  installation result from the previous workspace is rejected before a new
  user-config registration begins and cannot overwrite installer UI for the new
  workspace.
- Native package installation may already have written files before a workspace
  switch. A global user-config write that was already started may still finish;
  it is an approved global registration and stale UI completion is ignored.
- Session teardown clears that session's visible or pause-pending suggestion.

## Related files

- `external/pi-tools-suite/src/lsp/onboarding.ts`
- `external/pi-tools-suite/src/lib/lsp.ts`
- `external/pi-tools-suite/test/lsp-onboarding.test.ts`
- `desktop/src-tauri/src/lsp_install.rs`
- `desktop/src/lib/lsp-onboarding.ts`
- `desktop/src/app/lsp-onboarding.svelte.ts`
- `desktop/src/components/TranscriptPane.svelte`
- `desktop/src/components/LspInstallPane.svelte`
- `desktop/src/lib/workbench-tabs.ts`
- `desktop/src/app/workbench-model.ts`

## Verification

- pi-tools-suite onboarding tests cover catalog matching, registered-server
  suppression, and the structured private state event.
- Desktop helper tests cover trusted event parsing, comment-preserving/conflict-safe
  JSONC server registration, pause-pending teardown, serialized installation,
  and stale workspace completion.
- Workbench/model and source-level regressions cover the centered warning,
  pause/install wiring, dedicated installer tab, and no-auto-continue copy.
- Native Rust tests pin the trusted installer catalog and reject arbitrary
  installer identifiers.
