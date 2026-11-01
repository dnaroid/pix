---
kind: spec
status: active
---

# File link opening

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Open local links in the application appropriate to the current environment without sending media files to Zed.

## Behavior

- This screen-level opener contract applies to Pix terminal/TUI file opening.
  Pix Desktop intercepts validated bounded UTF-8 local text targets into its
  read-only Preview first; only targets that cannot be text-previewed fall back
  to the system opener, which may itself be configured to Zed.
- HTTP(S) links use the current OS system opener.
- When pix runs inside Zed, non-media local files open through the Zed CLI and preserve an available line and column.
- File references with a line range are opened at the range's first line because the Zed CLI target format does not preserve an end line.
- Image, video, and audio files always use the current OS system opener, including when pix runs inside Zed.
- Outside Zed, all local files use the current OS system opener.
- If the Zed CLI is unavailable, opening falls back to the current OS system opener.

## Non-goals

- Detecting or launching other code editors.
- Content-based MIME detection.
- Changing link detection or mouse hit-testing.

## Verification

- Unit tests cover Zed text links, range-to-first-line fallback, Zed media links, non-Zed links, and platform fallbacks.
- `npm run check`

## Evidence

- Confirmed by code: HTTP(S) links use the OS opener; inside Zed, non-media
  local files use the Zed CLI with line/column when available; media uses the OS
  opener; missing Zed CLI falls back to the OS opener.
- Confirmed by tests: focused opener tests cover Zed text/media paths and
  platform fallbacks; file-link detection tests cover range anchors degrading
  to their first line before the Zed target is built.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"4a946db424e020dce687ccee8ed943e8d1485fd3d5be92a0576b299dea3f12e7","checkedAt":"2026-10-31T00:11:00.101Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":57,"reportLanguage":"ru"} -->
