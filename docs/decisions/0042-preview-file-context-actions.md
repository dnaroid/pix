# 0042 — Native file actions for Preview and media

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested media/Preview right-click actions and
  explicitly selected actual-file copying plus menus on both tab and content.
- Governing spec: [Desktop context menus](../../specs/desktop-context-menus.md)
- Replaces / replaced by: none

## Context

Image menus already copy pixels and open externally. Video, Preview headers and
read-only file surfaces also need copy/open/reveal commands usable with Finder.

## Observations and sources

The existing generic native menu owns generation guards and resource teardown.
Project Explorer's clipboard is text encoded for Pix instances, not a native
Finder file transfer. Preview models distinguish display names from local paths.
These are code observations, not evidence of native OS acceptance testing.

## Decision

Reuse the generic menu owner, with trusted path metadata on Preview and attachment
surfaces. Preserve image pixel copying and editing/selection menus. Copy File
uses macOS native file-URL clipboard semantics; opening uses the OS default app.
Tab headers act on the underlying file rather than serializing an unsaved draft.
Backend validation remains mandatory. Desktop support remains macOS-only.

## Alternatives

- Copying path text does not satisfy the user's explicit file-copy choice.
- Reusing Explorer's encoded text payload would not enable Finder paste.
- Adding component-owned menus would duplicate native menu lifecycle ownership.

## Consequences

Users can transfer local files to Finder and open/reveal them consistently.
Remote/data-only sources cannot be revealed without a local file. Image content
copy and tab file copy intentionally differ. Native clipboard interoperability
still requires macOS acceptance evidence beyond mocked frontend tests.

## Revisit when

Desktop platform support changes, users require draft export or remote-video
caching, or native pasteboard compatibility tests expose application failures.
