# Pix QA Sandbox

Disposable project for testing the real Pix Desktop or TUI. This is project
data, not a replacement application or a browser QA target.

Search anchors: `PIX_QA_SANDBOX`, `QA_SEARCH_ALPHA`, `QA_SEARCH_BETA`.

## Starting state

- `src/greeting.mjs`: small editable JavaScript module.
- `test/greeting.test.mjs`: deterministic test; run `npm test` without installing packages.
- `docs/notes.md`: Markdown, Cyrillic text and a checklist.
- `data/items.json`: synthetic records for file/search/edit scenarios.
- `assets/badge.svg`: harmless local image for previews/attachments.

No credentials, providers, sessions, tasks database or model configuration are
copied from real projects. Create conversations and tasks in this disposable
project as required by the scenario. Each copy gets its own empty Git repository
with no commits, remotes or template hooks; never reuse the source checkout's history.

Each QA run receives a fresh copy. Keep edits inside that copy, not this template.
An explicit project/URL always takes precedence over the default sandbox.
Passing here does not prove real-project data, authentication or persistence.
