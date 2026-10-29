---
kind: spec
status: active
---

# TUI file and folder mentions

The TUI prompt supports `@` lookup for project files and folders using the shared local off-thread index. Nested `.gitignore` rules apply; symlinks are not traversed. The index updates incrementally, with watcher events coalesced over a fixed window; ignored ancestor noise does not trigger unnecessary refreshes. Failed worker requests retire the worker so a later query can retry, and failed watcher updates are rebuilt on the next query. Index startup is guarded against nested rendering.

Results are fuzzy-ranked, limited to 20, and shown in a popup; keyboard navigation selects a path and the prompt renders highlighted path tokens. Selection inserts text only (not attached/read contents). Paths are inserted as `@path`, JSON-quoted when quoting is needed, including paths containing `@` or backslashes. Slash-command and shell-command contexts are excluded; mention lookup suppresses LLM autocomplete and stale lookups are cancelled/ignored. Line ranges are not implemented.
