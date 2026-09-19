# Desktop user config editing

<!-- markdownlint-disable MD013 -->

## Type

As-is

## Lifecycle

Active implemented contract.

## Goal

Let Pix Desktop users view and edit its independent JSONC application profile (`~/.config/pi/pix-desktop.jsonc`) plus the Pi Tools Suite config (`~/.config/pi/pi-tools-suite.jsonc`) through a hand-designed Desktop settings editor without corrupting or partially overwriting those files. TUI `~/.config/pi/pix.jsonc` is never used as a Desktop fallback.

## Scope

- A Settings panel with `Desktop` and `Tools Suite` tabs, one per config kind.
- The Desktop tab exposes the complete set of settings consumed by Desktop/ACP while excluding terminal-renderer-only TUI settings.
- Settings use explicit product sections and purpose-built controls rather than deriving UI structure from JSON Schema properties.
- Because Settings lives in a narrow attached sidebar, section navigation uses one compact native select rather than a horizontally scrolling tab strip. The top-level `Desktop` / `Tools Suite` switch remains a fixed two-item tab row.
- Free-form/nested maps that do not have a stable bounded row model use deliberately placed structured JSON editors; the `Advanced` section always exposes the complete JSONC source as the lossless escape hatch.
- Load the config document, edit it through the curated controls or `Advanced` JSONC, and save it back to disk.
- Size limits and error handling for both read and write paths.

## Non-goals

- Editing arbitrary files or project-local settings.
- Applying saved config changes to already-running components; consumers re-read config on their own schedule.
- Authoring or versioning the JSON schemas themselves.
- Persisting unsaved drafts across application restarts (drafts live only in the in-memory editor cache).

## Behavior

- `read_user_config(kind)` resolves the file under the platform home directory: `~/.config/pi/pix-desktop.jsonc` for `desktop`, `~/.config/pi/pi-tools-suite.jsonc` for `pi-tools-suite`.
- Desktop never reads or migrates `~/.config/pi/pix.jsonc` as a fallback. A missing `pix-desktop.jsonc` starts from Desktop defaults/schema only, even when a TUI config exists.
- A missing config file is not an error: the document returns `exists: false` with default content `{ "$schema": "<schema-url>" }`; reading never creates the file.
- An existing file larger than 2 MiB, not a regular file, or unreadable fails with a descriptive error; the editor shows the error instead of content.
- The document carries the embedded JSON schema (from `schemas/pix-desktop.json` / `schemas/pi-tools-suite.json`) for validation and default resolution only. UI sections, labels, grouping, and control choice are hand-authored Desktop product code and are not generated from schema properties. `pix-desktop.json` contains only settings actually consumed by Desktop or its ACP backend.
- The editor keeps one in-memory draft per kind (source, saved source, parsed schema); switching tabs or remounting the panel preserves drafts, but restarting the app discards them.
- Field edits and resets apply through JSONC-aware path modification so comments elsewhere in the file survive. Booleans use switches; bounded enums use selects; numbers use constrained number inputs; secrets use password inputs. Desktop model fields and fallback lists consume the same ACP session model catalog as the existing Model & Thinking picker instead of requiring `provider/model` text entry. Existing configured refs that are absent from the current catalog remain representable and are never rewritten merely because the catalog changed.
- `visibleModels` is edited as an explicit “limit model picker” switch plus a model checklist; omitting the key means every catalog model is visible. Internal `thinkingByModel` memory is not exposed in the normal settings UI because Desktop maintains it automatically; it remains visible/editable only in `Advanced` JSONC.
- Pi Tools Suite fields that are semantically model references (lookup model/fallbacks and DCP summarizer/fallbacks) reuse the same catalog-backed model selectors; free-form model-pattern maps such as todo/DCP overrides remain structured JSON because wildcard keys are part of their contract.
- DCP defaults in Desktop are not read from the starter `pi-tools-suite.jsonc`
  template. For any omitted `dcp.*` key, Desktop resolves the same built-in
  runtime default object used by TUI `loadConfig()`; debug-log size/backup
  defaults come from the same shared DCP defaults module. Explicit values still
  come from the shared `~/.config/pi/pi-tools-suite.jsonc`, so Desktop's displayed
  current/effective DCP values match TUI rather than drifting to template values.
- Desktop Voice language/model and the external editor use bounded selects for common supported values. Non-standard/custom values already present in config remain preserved and appear as configured choices; adding a new custom value is an `Advanced` JSONC operation rather than a free-form field in the primary UI. Deliberately free-form nested records elsewhere use scoped structured JSON editors instead of a schema-generated catch-all field.
- `Advanced` edits the full JSONC text and is always available. If the current source has a JSONC parse error, structured sections are disabled and the panel directs the user to `Advanced` so malformed source can be repaired without losing comments.
- Saving is blocked while the source has issues: JSONC parse errors, a non-object root, or schema validation problems (bounded to the first 20 issues).
- Save uses `write_user_config_if_unchanged(kind, expectedContent, content)` with the draft's last saved source as the compare-and-swap baseline. If the file changed after the draft was loaded/saved, Desktop refuses the stale write and asks the user to reload instead of overwriting the newer file.
- Write normalizes the content first (append a trailing newline when missing) and enforces the 2 MiB limit on the normalized bytes; an oversized draft is rejected with a clear error before any filesystem change, so a failed save never creates, truncates, or replaces the config file.
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
- Desktop serializes config saves against sidebar health reads with a backend read/write lock, so the live Settings indicator cannot observe the intermediate truncate/write window of `fs::write`.
- Conditional writes compare the current file content and write the replacement while holding one backend write lock. This prevents two Desktop read/modify/write flows from losing each other's updates between separate read and write commands.

## Related files

- `desktop/src-tauri/src/lib.rs` (`read_user_config`, `write_user_config`, `write_user_config_if_unchanged`, `read_user_config_from`, `write_user_config_from`, `write_user_config_if_unchanged_from`, `user_config_path`)
- `desktop/src/components/SettingsPanel.svelte`
- `desktop/src/components/settings/DesktopSettingsEditor.svelte`
- `desktop/src/components/settings/ToolsSuiteSettingsEditor.svelte`
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
- Manual: in the native app, edit a value in a curated section with a comment present in `Advanced` JSONC, save, reopen `Advanced`, and confirm the unrelated comment and trailing newline handling. Also verify malformed JSONC routes to `Advanced` rather than presenting misleading structured values.

## Risks / unknowns

- The 2 MiB cap is a blunt guard; very large legitimate configs are rejected without a partial-write escape hatch.
- Drafts are lost on app restart by design; no crash-safety guarantee for unsaved edits.

## Evidence

- Confirmed by code: `write_user_config_from` computes `normalized` and checks `MAX_USER_CONFIG_BYTES` before `fs::write`; `read_user_config_from` returns default content for missing files and errors for oversized or non-file paths.
- Confirmed by tests: `user_settings_configs_resolve_under_the_platform_home_and_round_trip`, `desktop_user_settings_ignore_tui_pix_config`, and `user_settings_reject_normalized_content_over_the_size_limit_before_writing` (oversized input leaves the existing config byte-identical).
- Confirmed by code: `SettingsPanel.svelte` blocks save while `settingsSourceIssues` reports problems, generation-guards async loads, rejects stale compare-and-swap saves, reconciles a successful save response against the latest draft rather than clobbering edits typed during the write, and routes `DesktopSettingsEditor` / `ToolsSuiteSettingsEditor` through explicit section navigation instead of schema-generated field sections.
- Confirmed by tests: `reconcileSavedSettingsDraft` keeps newer in-memory edits while advancing `savedSource` to the document actually written to disk.
