# 0065 — Shared local repository search with a separate disposable file index

- Status: superseded
- Recorded: 2026-10-10
- Decided: 2026-10-10
- Owner / approval evidence: implementation decision within the user's explicit mandate to deliver an autonomous native lexical-first vertical slice; not approval of the earlier handoff architecture. Historical fallback clauses below were later removed.
- Governing spec: [Native repository search](../search/native-repository-search.md)
- Replaces / replaced by: [0066](0066-native-repository-semantic-search.md) adds opt-in native semantics while retaining the lexical storage/process boundary. This decision originally narrowed the external search prerequisite of [0060](0060-subagent-read-only-repo-tools.md) for `project_search` only, not `repo_*`.

## Context

Desktop and agent Code/Knowledge search previously depended on separate external
adapters. The handoff proposed `.pi/search/index.sqlite` as a likely shared native index.
The first slice must work without API keys or an active Desktop chat session, preserve
existing vectors and indexes, and avoid copying unrelated search capabilities.

## Observations and sources

- `external/pi-tools-suite/src/project-search/semantic-index-writer.ts` holds a
  `BEGIN IMMEDIATE` transaction across awaited embedding batches. Its busy timeout is
  35 seconds. Using the same SQLite file would couple local file freshness to provider latency.
- `acp/src/search/canonical-index.ts` and the session/task/commit stores already use
  `.pi/search/index.sqlite`. Existing namespaced tables are not a file-search migration API.
- `desktop/src-tauri/src/backend_runtime.rs` resolves the relocated tools-suite extension
  in both development and packaged runtimes, providing a session-independent process boundary.
- Independent repository checks confirmed that commit embedding configuration, repo context,
  AST/dependency views and knowledge dirty/acknowledge were outside the first slice.
- Assumption: bounded lexical retrieval is useful without semantic/AST parity. Its quality and
  large-repository limits must be measured, not inferred from FTS5 availability.

## Decision

Use one standalone tools-suite JS engine and typed result contract. TUI/ACP calls it in
an owned child process; Desktop invokes the same packaged entry through a small Tauri
transport, independent of ACP sessions. Parsing/hashing/SQLite never run on the UI thread.

Store only local file chunks/FTS5 metadata in `.pi/search/files.sqlite`, a disposable,
strictly owned schema. Leave `index.sqlite` and provider settings untouched.
Refresh on explicit search, using short atomic generation-checked publications. Retain the
prior complete snapshot on failed scans. Do not introduce background watchers or daemons.

Native lexical search is the default. [Later integration-removal work removed the
alternative-backend fallback clauses from this historical decision; they do not describe
current behavior.]

## Alternatives

- Reuse `index.sqlite`: plausible after removing embedding work from write transactions and
  defining a cross-runtime schema lifecycle, but unnecessarily expands this slice's risk.
- Put retrieval in ACP: reuses Node, but would require a new headless service lifecycle or
  couple Universal Search to an active session. A bounded standalone process is simpler here.
- Separate Rust and TypeScript engines: duplicates ranking, chunking, safety and schema rules.
- Immediately remove the alternative backend: at the time, this was considered a larger
  migration that could lose unverified structural, semantic and knowledge-review capabilities.
  [This historical alternative was later superseded; it is not current capability guidance.]

## Consequences

Two SQLite files under `.pi/search` are intentional. There is process-startup and bounded
filesystem-scan cost per repository request. The first version does not promise semantic
recall, AST-aware chunks, whole-repository graph views or huge-repository completeness.
No user data/index deletion is a migration step. Cache format rejection requires an explicit
future recovery flow rather than destructive auto-repair.

## Revisit when

Measurements justify a persistent worker or metadata-only warm scans; the existing vector
writer no longer holds locks over network work; native semantic/AST retrieval is approved;
or lexical quality/large-project limits prevent useful results for supported workspaces.
