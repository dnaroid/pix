# Desktop user config editing

<!-- markdownlint-disable MD013 -->

## Type

As-is

## Lifecycle

Active implemented contract.

## Goal

Let Pix Desktop users view and edit the two JSONC user config files (`~/.config/pi/pix.jsonc` and `~/.config/pi/pi-tools-suite.jsonc`) through a schema-driven settings editor without corrupting or partially overwriting those files.

## Scope

- A Settings panel with `Pix` and `Tools Suite` tabs, one per config kind.
- Load the config document, edit it via a generated form or raw JSONC mode, and save it back to disk.
- Size limits and error handling for both read and write paths.

## Non-goals

- Editing arbitrary files or project-local settings.
- Applying saved config changes to already-running components; consumers re-read config on their own schedule.
- Authoring or versioning the JSON schemas themselves.
- Persisting unsaved drafts across application restarts (drafts live only in the in-memory editor cache).

## Behavior

- `read_user_config(kind)` resolves the file under the platform home directory: `~/.config/pi/pix.jsonc` for `pix`, `~/.config/pi/pi-tools-suite.jsonc` for `pi-tools-suite`.
- A missing config file is not an error: the document returns `exists: false` with default content `{ "$schema": "<schema-url>" }`; reading never creates the file.
- An existing file larger than 2 MiB, not a regular file, or unreadable fails with a descriptive error; the editor shows the error instead of content.
- The document carries the embedded JSON schema (from `schemas/pix.json` / `schemas/pi-tools-suite.json`) so the editor renders sections, field types, defaults, and removed-setting markers from the schema.
- The editor keeps one in-memory draft per kind (source, saved source, parsed schema); switching tabs or remounting the panel preserves drafts, but restarting the app discards them.
- Field edits and resets apply through JSONC-aware modification so comments elsewhere in the file survive; raw JSONC mode edits the full text.
- Saving is blocked while the source has issues: JSONC parse errors, a non-object root, or schema validation problems (bounded to the first 20 issues).
- Save uses `write_user_config_if_unchanged(kind, expectedContent, content)` with the draft's last saved source as the compare-and-swap baseline. If the file changed after the draft was loaded/saved, Desktop refuses the stale write and asks the user to reload instead of overwriting the newer file.
- Write normalizes the content first (append a trailing newline when missing) and enforces the 2 MiB limit on the normalized bytes; an oversized draft is rejected with a clear error before any filesystem change, so a failed save never creates, truncates, or replaces the config file.
- A successful save writes the normalized content (creating `~/.config/pi` and the file when needed), then returns the freshly read document; the editor replaces its draft with the returned content so server-side normalization (trailing newline) is visible.
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
- `desktop/src/lib/settings.ts`
- `schemas/pix.json`
- `schemas/pi-tools-suite.json`

## Verification

- Run `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib user_settings` (round-trip and size-limit regression tests).
- Run the desktop Svelte/TypeScript checks and unit tests.
- Manual: in the native app, edit a value in the generated form with a comment present in raw mode, save, reopen raw mode, and confirm the comment and trailing newline handling.

## Risks / unknowns

- The 2 MiB cap is a blunt guard; very large legitimate configs are rejected without a partial-write escape hatch.
- Drafts are lost on app restart by design; no crash-safety guarantee for unsaved edits.

## Evidence

- Confirmed by code: `write_user_config_from` computes `normalized` and checks `MAX_USER_CONFIG_BYTES` before `fs::write`; `read_user_config_from` returns default content for missing files and errors for oversized or non-file paths.
- Confirmed by tests: `user_settings_configs_resolve_under_the_platform_home_and_round_trip` and `user_settings_reject_normalized_content_over_the_size_limit_before_writing` (oversized input leaves the existing config byte-identical).
- Confirmed by code: `SettingsPanel.svelte` blocks save while `settingsSourceIssues` reports problems, generation-guards async loads, rejects stale compare-and-swap saves, and reconciles a successful save response against the latest draft rather than clobbering edits typed during the write.
- Confirmed by tests: `reconcileSavedSettingsDraft` keeps newer in-memory edits while advancing `savedSource` to the document actually written to disk.
