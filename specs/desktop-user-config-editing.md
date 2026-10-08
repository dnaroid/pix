---
kind: spec
status: active
---

# Desktop user config editing

<!-- markdownlint-disable MD013 -->

## Type

As-is

## Lifecycle

Active implemented contract.

## Goal

Let Pix Desktop users view and edit its independent JSONC application profile (`~/.config/pi/pix-desktop.jsonc`) plus the Pi Tools Suite config (`~/.config/pi/pi-tools-suite.jsonc`) through a hand-designed Desktop settings editor without corrupting or partially overwriting those files. TUI `~/.config/pi/pix.jsonc` is never used as a Desktop fallback.

## Scope

- A single continuous Settings page containing both `Desktop` and `Tools Suite` configuration groups, without config tabs or a chapter selector.
- The Desktop group exposes the complete set of settings consumed by Desktop/ACP while excluding terminal-renderer-only TUI settings.
- Settings use explicit product sections and purpose-built controls rather than deriving UI structure from JSON Schema properties.
- A compact left-hand chapter index remains beside the scrollable content. Clicking a chapter scrolls to it below the file header; manual scrolling tracks and highlights the current visible chapter, including the final chapter at the bottom.
- Search stays above the left index and matches case-insensitive whitespace-separated terms against authored setting labels, descriptions and chapter titles. Nonmatching rows and empty chapters/config groups are hidden from content and navigation; clearing search restores all controls. Search never includes control values (especially secrets). Controls stay mounted to preserve local edits during filtering; no-match queries show an explicit empty state.
- Free-form/nested maps that do not have a stable bounded row model use deliberately placed structured JSON editors; the `Advanced` section is a compact launcher that opens the complete user-config source in the main editor tab as the lossless escape hatch.
- Load the config document, edit it through the curated controls or the user-config editor tab launched from `Advanced`, and save it back to disk.
- Size limits and error handling for both read and write paths.

## Non-goals

- Editing arbitrary files or general project-local settings.
- Applying saved config changes to already-running components; consumers re-read config on their own schedule.
- Authoring or versioning the JSON schemas themselves.
- Persisting unsaved drafts across application restarts (drafts live only in the in-memory editor cache).

## Behavior

- `read_user_config(kind)` resolves the file under the platform home directory: `~/.config/pi/pix-desktop.jsonc` for `desktop`, `~/.config/pi/pi-tools-suite.jsonc` for `pi-tools-suite`.
- Desktop never reads or migrates `~/.config/pi/pix.jsonc` as a fallback. A missing `pix-desktop.jsonc` starts from Desktop defaults/schema only, even when a TUI config exists.
- A missing config file is not an error: the document returns `exists: false` with default content `{ "$schema": "<schema-url>" }`; reading never creates the file.
- An existing file larger than 2 MiB, not a regular file, or unreadable fails with a descriptive error; the editor shows the error instead of content.
- The document carries the embedded JSON schema (from `schemas/pix-desktop.json` / `schemas/pi-tools-suite.json`) for validation and default resolution only. UI sections, labels, grouping, and control choice are hand-authored Desktop product code and are not generated from schema properties. `pix-desktop.json` contains only settings actually consumed by Desktop or its ACP backend.
- The editor keeps one in-memory draft per kind (source, saved source, parsed schema); filtering or remounting the panel preserves drafts, but restarting the app discards them. Both files load independently on mount and keep separate reload/save actions and lifecycle guards. Updating one file's cache entry merges against the latest cache so another mounted editor's draft cannot be overwritten.
- Field edits and resets apply through JSONC-aware path modification so comments elsewhere in the file survive. Booleans use switches; bounded enums use selects; numbers use constrained number inputs; secrets use password inputs. Desktop model fields and fallback lists consume the same ACP session model catalog as the existing Model & Thinking picker instead of requiring `provider/model` text entry. Existing configured refs that are absent from the current catalog remain representable and are never rewritten merely because the catalog changed. The Git section includes a **CI fix model** selector for `desktop.git.ciFixModelRef`; leaving it unset intentionally means “use the normal default model” rather than introducing a second hard-coded default.
- `visibleModels` is edited as an explicit “limit model picker” switch plus a model checklist; omitting the key means every catalog model is visible. Internal `thinkingByModel` memory is not exposed in the normal settings UI because Desktop maintains it automatically; it remains visible/editable only through the full JSONC editor launched from `Advanced`.
- Assistant features includes **Knowledge review model**, a catalog-backed model/optional-thinking selector for `desktop.knowledge.reviewModelRef`. Reset/empty selection removes the override so knowledge-base AI review uses the normal new-session default; saved changes apply to the next review, not existing sessions. Project-local Desktop config can override the global value. This setting is separate from the `knowledge-auditor` role; see [Desktop IDX panel](desktop-idx-panel.md).
- Assistant features includes explicit-opt-in **Semantic search**, plus a masked,
  write-only shared OpenRouter key input when credentials are missing. The key
  is never stored in the Desktop JSONC document. The control discloses sending
  authored settings metadata and settings-search queries to the fixed embedding
  model. Session-title lookup is local lexical search; titles and conversation
  history are never sent to the provider. Local search works without semantic
  consent. There is no message-noise-filter control or message-body index;
  legacy `search.messageFilterEnabled` config keys are ignored.
  Preferences loads are workspace/client scoped and canceled on teardown; see
  [Desktop universal search](desktop-universal-search.md).
- Universal search uses a separate authored settings catalogue with stable
  field IDs. Its deep link opens Settings, clears local filtering, scrolls to
  the exact row and focuses its control after the editor mounts. No configured
  values or secrets are searchable.
- Pi Tools Suite fields that are semantically model references (lookup model/fallbacks and DCP summarizer/fallbacks) reuse the same catalog-backed model selectors; free-form model-pattern maps such as todo/DCP overrides remain structured JSON because wildcard keys are part of their contract.
- Pi Tools Suite `disabledBuiltinAgents` is edited as a curated checklist of the
  bundled async-subagent catalog. Desktop discovers the top-level bundled
  `agents/*.md` definitions at frontend build time, so adding/removing a bundled
  role automatically changes the checklist on the next build; `icon` and
  `description` frontmatter provide display metadata, with the neutral agent
  icon as fallback. Checked means the bundled role remains available; unchecked
  stores that role name in `disabledBuiltinAgents`. Unknown configured names are
  preserved. Project-local `.pi/agents/<name>.md` roles are unaffected by this
  user-level bundled-role visibility control.
- Pi Tools Suite module enablement is edited as one bundled-module checklist
  rather than exposing `enabledModules`, `disabledModules`, or the `modules`
  object as raw controls. The checklist consumes the suite's ordered
  metadata-only module catalog, which is also the single source used to derive
  runtime module registration by the conventional `src/<module-name>/index.ts`
  path. The checklist starts from each module's runtime
  default, replays the supported list/map precedence (including legacy
  `*Extensions` aliases), and writes checkbox choices as final `modules` map
  overrides. The lightweight shared module catalog also supplies a short
  description shown on row hover, matching the bundled-agent checklist pattern.
  Unknown configured names remain preserved and are reported below the checklist;
  the full raw forms remain available through the JSONC editor launched from `Advanced`.
- The module checklist includes default-on `codemode` for SDK QuickJS scripts
  alongside ordinary tools. Its `modules.codemode` override takes effect after
  extension reload/session restart, not immediately on save; see
  [Suite codemode](suite-codemode.md) for host and restricted-selection behavior.
- DCP defaults in Desktop are not read from the starter `pi-tools-suite.jsonc`
  template. For any omitted `dcp.*` key, Desktop resolves the same built-in
  runtime default object used by TUI `loadConfig()`; debug-log size/backup
  defaults come from the same shared DCP defaults module. Explicit values still
  come from the shared `~/.config/pi/pi-tools-suite.jsonc`, so Desktop's displayed
  current/effective DCP values match TUI rather than drifting to template values.
- Desktop Voice language/model and the external file editor use bounded selects for common supported values. The editor list includes Gram, Zed, VS Code, Cursor, Sublime Text, IntelliJ IDEA, and WebStorm. Desktop does not assume Zed (or any other editor) when `desktop.externalEditor` is omitted; external-editor actions ask the user to choose one in Desktop Settings. Non-standard/custom values already present in config remain preserved and appear as configured choices; adding a new custom value is a full-JSONC editor operation launched from `Advanced` rather than a free-form field in the primary UI. Deliberately free-form nested records elsewhere use scoped structured JSON editors instead of a schema-generated catch-all field.
- `Advanced` does not embed a second source textarea in the narrow Settings sidebar; it exposes an `Open in editor` button. The button reads the selected config through `read_user_config(kind)`, opens it in the main Preview/editor workbench tab, and marks that preview as a user-config target.
- User-config previews are editable even though generic home/absolute local previews remain read-only. Saving from the editor tab uses `write_user_config_if_unchanged(kind, expectedContent, content)` with the loaded preview content as the compare-and-swap baseline; a successful save refreshes the preview from the returned normalized document. If the current source has a JSONC parse error, structured sections are disabled and the panel directs the user straight to this editor-tab path so malformed source can be repaired without losing comments.
- `Open in editor` is disabled while the current Settings sidebar draft is dirty; the sidebar draft must be saved or reloaded first so the editor tab starts from the disk baseline.
- Saving is blocked while the source has issues: JSONC parse errors, a non-object root, or schema validation problems (bounded to the first 20 issues).
- Save uses `write_user_config_if_unchanged(kind, expectedContent, content)` with the draft's last saved source as the compare-and-swap baseline. If the file changed after the draft was loaded/saved, Desktop refuses the stale write and asks the user to reload instead of overwriting the newer file.
- Write normalizes the content first (append a trailing newline when missing) and enforces the 2 MiB limit on the normalized bytes before filesystem ownership or the compare-and-swap baseline check; even a stale oversized draft is rejected with a clear size error before any filesystem change, so a failed save never creates, truncates, or replaces the config file.
- A successful save writes the normalized content (creating `~/.config/pi` and the file when needed), then returns the freshly read document; the editor replaces its draft with the returned content so server-side normalization (trailing newline) is visible.
- Desktop launches its ACP backend with `PIX_CONFIG_PROFILE=desktop`. ACP user/project reads therefore resolve to `pix-desktop.jsonc` / `$WORKSPACE/.pi/pix-desktop.jsonc`; the default profile remains `pix.jsonc` / `$WORKSPACE/.pi/pix.jsonc` for TUI-compatible ACP use.
- Reload with unsaved changes requires explicit discard confirmation; loading or saving failures surface as an error message while keeping the draft intact.
- Async loads are generation-scoped per config kind and ignored after teardown, so a slow older read cannot replace a newer reload or surface an error for a different active config. Reload is disabled while a save is in flight.
- Editing may continue while a save is in flight. The submitted source becomes the new disk baseline on success, but any newer in-memory edits are preserved and remain dirty instead of being overwritten by the older save response.

## Contracts

- `MAX_USER_CONFIG_BYTES` is 2 MiB and applies to both read (existing file size) and write (normalized content length) paths.
- The write path validates before mutating: normalization → size check → directory/file checks → write → re-read.
- The size check on write covers the normalized content, not the raw input, so an input exactly at the limit without a trailing newline is rejected instead of writing a file one byte over the limit.
- Writes preserve JSONC comments and formatting outside edited values; the only mandatory mutation is the trailing newline.
- Desktop serializes config saves against sidebar health reads with a backend read/write lock. Native writes publish normalized content through a private same-directory temporary file and atomic rename, so readers do not observe a truncated document.
- Native unconditional/conditional config saves and ACP semantic-consent updates additionally share a filesystem directory lock at `<config-path>.search.lock`, including when the config does not yet exist. Conditional saves acquire ownership before reading/comparing the baseline and retain it through publication; ACP edits read the current JSONC under the same ownership. This prevents cross-process saves from losing unrelated keys or restoring revoked consent. Native blocking work remains on the blocking pool.
- Contention is bounded to approximately one second and reported as a busy error without writing; the atomic publish retries transient reader contention (Windows fails renames over handles open without FILE_SHARE_DELETE) on the same budget before failing. Writers release ownership on success/failure and never steal a lock because its mtime is old: a paused live writer must remain protected. A crash-leftover lock fails closed; manual recovery may remove it only after confirming all owners have exited. No automatic stale-lock cleanup is performed.

## Implementation

- `desktop/src-tauri/src/lib.rs`
- `acp/src/search/config.ts`
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/settings/SettingsConfigEditor.svelte`
- `desktop/src/components/settings/SettingsSectionNav.svelte`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsBuiltinAgentVisibility.svelte`
- `desktop/src/components/settings/SettingsModuleVisibility.svelte`
- `desktop/src/components/settings/SettingsFieldRow.svelte`
- `desktop/src/components/settings/SettingsSearchPreferences.svelte`
- `desktop/src/lib/settings-search-catalog.ts`
- `desktop/src/lib/settings.ts`
- `desktop/src/lib/settings-navigation.ts`
- `desktop/src/lib/settings-viewport.ts`
- `desktop/src/lib/builtin-agent-catalog.ts`
- `desktop/src/lib/tools-suite-module-visibility.ts`
- `desktop/src/lib/default-desktop-config.ts`
- `desktop/src/lib/desktop-config.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `schemas/pi-tools-suite.json`
- `acp/src/acp/pix-config-paths.ts`

## Tests

- `acp/test/search-preferences.test.ts`

- `tests/pix-desktop-search-schema.test.ts`

- `desktop/src-tauri/src/lib.rs` (`user_settings` module)
- `desktop/src/lib/desktop-config.test.ts`
- `desktop/src/lib/settings.test.ts`
- `desktop/src/lib/settings-navigation.test.ts`
- `desktop/src/lib/settings-search-catalog.test.ts`
- `desktop/src/lib/settings-viewport.test.ts`
- `desktop/src/app/desktop-workbench-prop-builders.test.ts`
- `desktop/src/components/DesktopVisualRegressions.test.ts`

## Related files

- `desktop/src-tauri/src/lib.rs` (`read_user_config`, `write_user_config`, `write_user_config_if_unchanged`, `read_user_config_from`, `write_user_config_from`, `write_user_config_if_unchanged_from`, `user_config_path`)
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/settings/SettingsConfigEditor.svelte`
- `desktop/src/components/settings/SettingsSectionNav.svelte`
- `desktop/src/lib/settings-navigation.ts` and `settings-navigation.test.ts`
- `desktop/src/lib/settings-viewport.ts` and `settings-viewport.test.ts`
- `desktop/src/components/WorkspaceSidebar.svelte`
- `desktop/src/app/desktop-sidebar-view-model.svelte.ts`
- `desktop/src/app/preview-state.svelte.ts`
- `desktop/src/app/preview-file-io.ts`
- `desktop/src/app/preview.svelte.ts`
- `desktop/src/app/desktop-workbench-prop-builders.ts`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`
- `desktop/src/components/settings/SettingsBuiltinAgentVisibility.svelte`
- `desktop/src/lib/builtin-agent-catalog.ts`
- `desktop/src/components/settings/SettingsModuleVisibility.svelte`
- `desktop/src/lib/tools-suite-module-visibility.ts`
- `desktop/src/components/settings/SettingsFieldRow.svelte` and typed control components in the same directory
- `desktop/src/lib/settings.ts`
- `desktop/src/lib/default-desktop-config.ts`
- `src/schemas/pix-desktop-schema.ts`
- `schemas/pix-desktop.json`
- `acp/src/acp/pix-config-paths.ts`
- `schemas/pi-tools-suite.json`

## Verification

- Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib user_settings` (round-trip and size-limit regression tests).
- Run the desktop Svelte/TypeScript checks and unit tests.
- Manual: in the native app, use the left chapter index to reach `Advanced` and confirm it shows only `Open in editor`; click it and confirm the matching Desktop or Tools Suite config opens editable in the main editor tab. Save there and confirm comments plus trailing-newline normalization are preserved, while ordinary absolute/home local previews remain read-only. Also verify malformed JSONC routes to the same editor-tab path rather than presenting misleading structured values.
- Manual: scroll through both configuration groups and verify current-chapter tracking, then search by a setting description, check hidden empty chapters and the no-results state, and clear the query. A draft edit must survive filtering and clearing; never search secret control values.

## Risks / unknowns

- The 2 MiB cap is a blunt guard; very large legitimate configs are rejected without a partial-write escape hatch.
- Drafts are lost on app restart by design; no crash-safety guarantee for unsaved edits.

## Evidence

- Confirmed by code: both native write paths normalize and check `MAX_USER_CONFIG_BYTES` before shared filesystem ownership and atomic publication; `read_user_config_from` returns default content for missing files and errors for oversized or non-file paths.
- Confirmed by tests: `user_settings_configs_resolve_under_the_platform_home_and_round_trip`, `desktop_user_settings_ignore_tui_pix_config`, and `user_settings_reject_normalized_content_over_the_size_limit_before_writing` (oversized input leaves the existing config byte-identical).
- Confirmed by code: `SettingsConfigEditor.svelte` blocks save while `settingsSourceIssues` reports problems, generation-guards async loads, rejects stale compare-and-swap saves, reconciles a successful save response against the latest draft rather than clobbering edits typed during the write, renders all authored chapters of `DesktopSettingsEditor` / `ToolsSuiteSettingsEditor`, and makes `Advanced` a launcher instead of an inline source textarea. `SettingsPanel.svelte` owns the shared search/index and aggregates errors from both files; `settings-viewport.ts` filters authored row metadata and tracks visible chapters with frame-coalesced scroll work, disposing observers/listeners on teardown. Preview state marks user-config targets; preview file I/O reads and saves them through the dedicated user-config commands; the workbench builder makes only those marked local previews editable while ordinary home/absolute local previews stay read-only.
- Confirmed by tests: `desktop-workbench-prop-builders.test.ts` verifies user-config previews are editable and save through `saveUserConfig` while generic local previews remain read-only; `DesktopVisualRegressions.test.ts` verifies the inline Advanced JSONC textarea is absent and the editor launcher remains present.
- Confirmed by tests: `reconcileSavedSettingsDraft` keeps newer in-memory edits while advancing `savedSource` to the document actually written to disk.
