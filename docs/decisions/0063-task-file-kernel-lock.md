# 0063 — Kernel-owned cross-process task-file exclusion

- Status: superseded (historical; not implemented by the current task store)
- Recorded: 2026-10-10
- Decided: 2026-10-10
- Owner / approval evidence: user selected option 1 (OS advisory locking) in the
  tasks-file concurrency discussion; parent selected the interoperable binding.
  Conversation-only approval; no separate durable approval artifact.
- Governing specs: [Desktop tasks](../desktop-task-manager.md),
  [agent tool](../../specs/project-tasks-agent-tool.md)
- Replaces / replaced by: [0064 — SQLite project tasks](0064-sqlite-project-tasks.md)

## Context

Rust's mutex and Node's file-mutation queue cannot exclude independent writers.
Atomic rename and final comparisons alone leave a check-to-rename race. The
whole-document format and existing stale-baseline rejection must remain intact.

## Observations and sources

- Both writers already have atomic persistence and comparison checks; see the
  governing specs and their implementation sections.
- Review of an attempted age-based lease found that a suspended holder can lose
  ownership, and stale-read/unlink can remove a new owner's lock. These were
  agent-reported/reproduced in this task; the unsafe drafts are not the contract.
- Rust `File::try_lock` uses flock on Unix and LockFileEx on Windows. Regression
  tests in `external/pi-tools-suite/test/project-tasks-lock.test.ts` exercise
  independent Node owners, crash/suspension, and optional Rust/Node interoperability.
- Native Windows execution and network-filesystem behavior were not verified on
  the macOS development host; they remain coverage limits, not proven guarantees.

## Decision

Use a persistent `.pi/.tasks.jsonc.lock` regular-file inode and kernel ownership
through the complete compare/commit critical section. Never remove/reclaim the
inode or expire a live holder. Close releases; crashes release through the OS.
Bound contention waits to five seconds, keeping existing conflict checks.

Node uses mutation-only Koffi bindings for nonblocking flock/LockFileEx; Rust
uses the standard File lock. Include Koffi in the suite, root and ACP runtime
dependencies because packaged extensions run under root/ACP module resolution.
Fail closed if native locking is unavailable. Desktop remains macOS-only.

## Alternatives

- Age-based atomic-create locks: rejected because expiry/reclamation cannot
  safely preempt a live holder and pathname deletion splits ownership.
- Stronger hashes/retries alone: do not eliminate the final check-to-rename race.
- Single write service: would couple standalone agent writes to Desktop/service
  availability; larger change than interoperable OS exclusion.
- Unix-only fs-ext: would leave Windows TUI without the same protocol. Koffi
  supports the required Win32 binding and supplies prebuilt native packages.

## Consequences

Participating writers exclude one another without stale-lock cleanup, including
after crashes. This introduces a native dependency and a permanent sibling file;
deployments must retain its binary and must not clean the sibling while running.
Advisory locks do not control editors/old clients or hostile path replacement.
Network filesystem compatibility and non-macOS native validation remain limits.

## Revisit when

Native packaging/support failures appear, a supported filesystem cannot provide
compatible locks, or a shared write service becomes a product requirement.
