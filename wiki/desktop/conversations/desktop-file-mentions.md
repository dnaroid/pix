---
kind: spec
status: active
---

# Desktop file and folder mentions

## Type

Change

## Lifecycle

Active implemented contract.

## Behavior

- Typing `@` in the Desktop prompt composer searches local project files and folders. A shared off-UI-thread index applies nested `.gitignore` rules, does not traverse symlinks, and updates incrementally from file watching. Results are fuzzy-ranked and limited to 20.
- The composer displays path chips beside the native textarea. Arrow keys navigate, Enter/Tab select, Escape dismisses, and mouse selection and accessible announcements are supported.
- Selection inserts plain `@path`; paths with spaces or quotes use JSON quoting. It inserts text only: the completion never reads or attaches file contents. The model receives the literal text and may later read paths using tools.
- Mention context is keyed by workspace as well as session/draft state. Lookup suppresses LLM autocomplete. Requests are debounced and aborted/ignored when stale; project/session teardown is guarded. Slash-command and shell-command contexts are excluded.
- Drafts without an active session are supported through the cwd-scoped ACP `pix/files/complete` extension.

Insertion is plain `@path` unless the path contains spaces, `@`, backslashes, or quotes; those paths are JSON-quoted. Line-range selection is not implemented.

## Related

- [Desktop prompt autocomplete](desktop-autocomplete.md)
- [TUI](../../tui/index.md)
