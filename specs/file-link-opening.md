# File link opening

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Open local links in the application appropriate to the current environment without sending media files to Zed.

## Behavior

- HTTP(S) links use the current OS system opener.
- When pix runs inside Zed, non-media local files open through the Zed CLI and preserve an available line and column.
- Image, video, and audio files always use the current OS system opener, including when pix runs inside Zed.
- Outside Zed, all local files use the current OS system opener.
- If the Zed CLI is unavailable, opening falls back to the current OS system opener.

## Non-goals

- Detecting or launching other code editors.
- Content-based MIME detection.
- Changing link detection or mouse hit-testing.

## Related files

- `src/app/screen/file-link-opener.ts`
- `tests/screen-openers.test.ts`

## Verification

- Unit tests cover Zed text links, Zed media links, non-Zed links, and platform fallbacks.
- `npm run check`

## Evidence

- Confirmed by code: HTTP(S) links use the OS opener; inside Zed, non-media
  local files use the Zed CLI with line/column when available; media uses the OS
  opener; missing Zed CLI falls back to the OS opener.
- Confirmed by tests: focused opener tests cover Zed text/media paths and
  platform fallbacks.
