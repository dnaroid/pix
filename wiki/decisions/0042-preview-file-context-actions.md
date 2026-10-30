# 0042 — Native file actions for Preview and media

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested media/Preview right-click actions and
  explicitly selected actual-file copying plus menus on both tab and content.
- Governing spec: [Desktop context menus](../desktop/workbench/desktop-context-menus.md)
- Replaces / replaced by: none

## Context

Image menus already copy pixels and open externally. Video, Preview headers and
read-only file surfaces also need copy/open/reveal commands usable with Finder.

## Observations and sources

The existing generic native menu owns generation guards and resource teardown.
Project Explorer's clipboard previously used text encoded for Pix instances;
native macOS Explorer Copy now additionally publishes Finder file URLs while
retaining the Pix reference. Preview models distinguish display names from local
paths.
These are code observations, not evidence of native OS acceptance testing.

## Decision

Reuse the generic menu owner, with trusted path metadata on Preview and attachment
surfaces. Preserve image pixel copying and editing/selection menus. Copy File
uses macOS native file-URL clipboard semantics; opening uses the OS default app.
Tab headers act on the underlying file rather than serializing an unsaved draft.
Backend validation remains mandatory. Desktop support remains macOS-only.

## Alternatives

- Copying path text does not satisfy the user's explicit file-copy choice.
- Reusing Explorer's Pix reference alone would not enable Finder paste; its
  native file-URL representation provides that interoperability.
- Adding component-owned menus would duplicate native menu lifecycle ownership.

## Consequences

Users can transfer local files to Finder and open/reveal them consistently.
Remote/data-only sources cannot be revealed without a local file. Image content
copy and tab file copy intentionally differ. Native clipboard interoperability
still requires macOS acceptance evidence beyond mocked frontend tests.

## Revisit when

Desktop platform support changes, users require draft export or remote-video
caching, or native pasteboard compatibility tests expose application failures.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"3094e9cead0f9facb4ea766dbc9e76eb8b6d8dbcc2734ea056c1e9d8ccd0d73a","checkedAt":"2026-10-30T23:46:45.466Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":53,"reportLanguage":"ru"} -->
