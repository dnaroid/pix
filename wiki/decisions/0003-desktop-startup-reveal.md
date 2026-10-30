# 0003 — Reveal Desktop after the initial document loads

- Status: accepted
- Recorded: 2026-10-02
- Decided: 2026-10-02
- Owner / approval evidence: coding agent implementation choice for the user's reported startup-flash regression; not a separate user architecture approval
- Governing spec: [Desktop startup theme](../desktop/workbench/desktop-startup-theme.md)
- Replaces / replaced by: none

## Context

The user reported that a white launch flash returned while using dark appearance.
The existing visual contract prohibits a white startup canvas in dark mode.

## Observations and sources

- Existing `startup_theme.rs` applies the native background only after window creation.
- Installed Tauri 2.11.5 documents that its background-color API does not cover the macOS WebView layer.
- `desktop/index.html` already provides system-aware inline CSS before the bundle.
- The user report is conversation-only; it does not establish measured duration or a captured reproduction.

## Decision

Centralize creation in `startup_theme::build`, create hidden, apply the native
palette and reveal on the first finished document load. Use a one-shot guard so
reloads cannot show a subsequently hidden window. Preserve configured hidden
windows. Do not wait for workspace or network readiness.

## Alternatives

- Native background alone: does not cover the macOS WebView's blank surface.
- Fixed delay: timing-dependent and can still expose a slow-loading white canvas.
- Frontend readiness IPC: adds another lifecycle dependency when document load
  already covers the inline startup background needed here.

## Consequences

Expected to remove the unpainted launch surface for all creation paths without
blocking the main thread. A load that never finishes leaves the window hidden;
native UI QA is necessary to establish actual paint timing.

## Revisit when

Native launch capture still exposes white frames, load completion precedes CSS
painting, or failed navigation needs a separate visible error surface.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"812e615a2575d370f0667737411d6c92d1ef6f620d738b13177969866d5baede","checkedAt":"2026-10-30T23:43:39.821Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":49,"reportLanguage":"ru"} -->
