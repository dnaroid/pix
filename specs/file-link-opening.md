# Spec: File link opening

## Type

Change

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

- Confirmed by code: file links currently prefer any detected editor and then fall back to the OS opener.
- Confirmed by tests: existing tests cover Zed, VS Code, Linux, and Windows launch commands.
- Intended behavior: the rules above were confirmed by the user.
