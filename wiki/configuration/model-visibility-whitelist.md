# Model visibility whitelist

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Give Pix TUI and Desktop user-controlled model-picker whitelists while keeping the underlying runtime/ACP catalogs complete and keeping each frontend's preference storage independent.

## Scope

- `visibleModels` in TUI user `~/.config/pi/pix.jsonc` and Desktop user `~/.config/pi/pix-desktop.jsonc`.
- The TUI combined model/thinking picker.
- The Desktop combined model/thinking picker.
- The temporary Desktop BTW side chat uses that same picker and preference.
- Model-picker filtering only; session scope and model availability remain separate concepts.

## Behavior

- `visibleModels` is an optional array of exact `provider/model` refs. When omitted, the corresponding Pix frontend shows every model in its complete available catalog.
- An explicit whitelist, including `[]`, is authoritative for picker visibility. The current active model is always kept visible so the picker cannot enter an invalid current-selection state.
- The preference is user-level but not shared across TUI and Desktop. TUI persists to `pix.jsonc`; Desktop persists to `pix-desktop.jsonc`. Project profile files do not override the corresponding picker whitelist.
- TUI builds its picker from the complete `ModelRuntime.getAvailableSnapshot()` rather than `session.scopedModels`; `enabledModels` continues to control SDK session scope/cycling but not picker visibility.
- TUI `Shift+Tab` toggles `Manage visible models`. Management mode exposes hidden models, `Enter`/mouse click toggles the highlighted model, and the current model cannot be hidden. A clickable `Clear all` action saves `visibleModels: []`, hiding every non-current model. Edits are persisted immediately.
- Desktop exposes a `Manage` mode in the same model/thinking dialog. It shows the complete ACP model option catalog with visibility checkmarks, saves changes immediately to the Desktop profile's `visibleModels` key, and prevents hiding the current model. `Clear all` saves an empty whitelist; the current model remains visible only through the current-model safety rule. `Shift+Tab` also toggles the mode while focus is in model search.
- Desktop visibility saves use a compare-and-swap user-config write and retry against the newest document when another Desktop config writer wins the race. The picker may be closed while a visibility save is in flight; reopening waits for that save before reading the whitelist so an older read cannot reopen stale picker state.
- Normal model selection never removes entries from the runtime or ACP model catalog; the whitelist is a presentation filter only.
- BTW shares the Desktop whitelist and Manage writes, but keeps its selected
  model/effort in memory independently of the parent. Each picker preserves its
  own current-model exception; an empty whitelist therefore shows the parent
  model in the statusbar picker and the side model in BTW. Auto and parent
  defaults are not exposed by BTW. See [the BTW contract](../desktop/conversations/desktop-btw.md).
- The project Tasks editor reuses the same Desktop combined model/thinking
  picker and its `visibleModels` preference for an **optional per-task**
  model/effort override. It can show the full ACP catalog in Manage mode and
  keeps the currently assigned task model visible even when outside the
  whitelist. Applying a selection only updates the task editor draft; it
  never mutates a live ACP session or Desktop-wide model defaults. A matching
  staged model+effort still writes the task override instead of treating Apply
  as a no-op; clearing the selection restores normal session defaults.

## Verification

- Root config tests cover normalization, persistence, explicit empty whitelists, and project-override suppression.
- TUI menu tests cover full-catalog behavior under an explicit session scope and normal-vs-management whitelist filtering.
- TUI popup/input tests cover the visibility mode and `Shift+Tab` routing.
- Desktop unit tests cover JSONC whitelist parsing/updating; `svelte-check` covers the picker integration.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"f17e118a0ce7051bda5f9528c4377ce95ee97fe73d801f065c879eace4123ece","checkedAt":"2026-10-30T23:04:25.028Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":62,"reportLanguage":"ru"} -->
