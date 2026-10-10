# Decision log

Specifications describe the current contract; decision records explain why a
significant choice was made and when it should be revisited. These Markdown
files are ordinary repository knowledge, searchable subject to idx exclusions.
No new database, document kind, or automatic enforcement is introduced.

## When to write

Default to no new record. Specs describe what and how; the decision log preserves
why a consequential path was chosen, not a changelog of features or completed tasks.
Write a record when the user explicitly requests one, or when both apply:

- The choice involves materially different plausible alternatives, a consequential
  accepted risk, or a costly-to-reverse commitment.
- Its rationale will help a future maintainer avoid repeating a dispute or mistake
  and is not already captured by an applicable record.

Ask: “Will this rationale still be useful in six months?” Architecture,
dependency/model choices and rejected alternatives are candidates, not automatic
triggers. Feature size or a changed spec alone does not justify a record. Routine
UX changes, bug fixes, implementation details, formatting and mechanical renames
normally belong only in the current spec when behavior changes. They need a record
only if they independently meet the threshold above. Do not invent alternatives
to fill the template; link an existing applicable record instead of duplicating it.

Apply this threshold to future records. Do not prune or rewrite historical records
merely because they would not meet it today.

The parent writes the rationale while the evidence and user discussion are
available, not after context is lost. Use [TEMPLATE.md](TEMPLATE.md), one file per
decision named `NNNN-short-topic.md`; choose the next unused number and never
overwrite an existing record. Keep the record concise and link supporting
material rather than copying transcripts. Never include credentials or secrets.

## Evidence and authority

Distinguish directly verified facts, user/agent-reported observations, hypotheses
and expectations. Cite repository-relative specs, tests, reports or commits when
available. For conversation-only evidence, identify the discussion and who
reported it; explicitly say if no durable artifact exists. Do not invent links,
measurements, approval or historical motives from the final implementation.

Each record links its governing spec; the spec links back. Before changing a
contract, read relevant decisions and check their status and replacement links.
An accepted record explains the choice but does not replace the current spec.
Conflicts require clarification, not silently choosing historical behavior.

## Lifecycle and review

Statuses: `proposed`, `accepted`, `superseded`, `withdrawn`. Identify the decision
owner/approval evidence and recording date; distinguish retrospective recording
from the date of the original decision when known. Unknown dates remain unknown.

The parent/user owns acceptance and replacement. When the choice changes, write
a new record linking the old one, mark the old `superseded` and link the successor;
retain its original reasoning. Minor factual/link corrections may be annotated,
but do not rewrite past rationale to fit today's outcome. A withdrawn proposal
is retained with its reason. Revisit triggers initiate review, not automatic
status transitions.

At final handoff, give `knowledge-auditor` the decision paths and rationale, plus
the normal behavior summary and exact task-changed paths; state explicitly when
no new decision was needed. The auditor checks completeness and consistency and
escalates missing/ambiguous rationale. It may repair small proven documentation
errors, not invent or approve decisions.

## Records

- [0064 — SQLite project tasks without legacy storage](0064-sqlite-project-tasks.md)
- [0063 — Kernel-owned task-file exclusion](0063-task-file-kernel-lock.md)
- [0061 — Scoped AST and public web tools for subagents](0061-subagent-scoped-ast-web-tools.md)
- [0060 — Read-only repository queries for every subagent](0060-subagent-read-only-repo-tools.md)
- [0059 — Private todos for every subagent role](0059-subagent-private-todos.md)
- [0058 — Reverse navigation into Files](0058-reverse-file-navigation.md)
- [0001 — Subagent coding roles](0001-subagent-coding-roles.md)
- [0002 — Agent-owned decision history](0002-agent-owned-decision-history.md)
- [0003 — Reveal Desktop after the initial document loads](0003-desktop-startup-reveal.md)
- [0004 — External TUI incident profiling](0004-external-tui-incident-profiling.md)
- [0005 — Disk-saving native watch builds](0005-watch-all-cargo-disk.md)
- [0006 — Embedded opt-in TUI incident trace](0006-embedded-tui-incident-trace.md)
- [0007 — Native spelling corrections in the macOS composer](0007-native-composer-spelling.md)
- [0008 — Configured brainstorm council](0008-configured-brainstorm-council.md)
- [0009 — Five-round brainstorm with reviewed synthesis](0009-five-round-brainstorm.md)
- [0010 — Audit scenario and transparent parent routing](0010-audit-council-modes.md)
- [0011 — Read-only council research capabilities](0011-council-research-tools.md)
- [0017 — Brainstorm v4: local protocol storage, quorum and ledger history](0017-brainstorm-v4-protocol-storage.md)
- [0018 — Identity-only Desktop message actions](0018-desktop-message-action-identity.md)
- [0019 — Desktop councils own persistent participant sessions](0019-desktop-persistent-council-sessions.md)
- [0022 — Run-only council roster and effort](0022-brainstorm-run-roster.md)
- [0023 — Remove workspace tool](0023-remove-workspace-tool.md)
- [0024 — Native Desktop close warnings](0024-desktop-close-warning.md)
- [0025 — Sparse read-only sidebar health](0025-sidebar-health-polling.md)
- [0026 — Cross-instance Project Explorer clipboard](0026-cross-instance-file-clipboard.md)
- [0026 — Pause-ready adopted continuations](0026-pause-ready-adopted-continuations.md)
- [0027 — Cause-specific sidebar quick actions](0027-sidebar-reason-actions.md)
- [0028 — Native Project Explorer context menu](0028-native-explorer-context-menu.md)
- [0028 — Scoped file-operation reservations](0028-scoped-file-operation-reservations.md)

- [0033 — Assistant prompt hygiene](0033-assistant-prompt-hygiene.md)
- [0034 — Bounded, opt-in Heads up observer](0034-heads-up-observer.md)
- [0046 — Task-scoped knowledge audit completion](0046-task-scoped-knowledge-completion.md)
- [0047 — Remove the Desktop Session inspector](0047-remove-session-inspector.md)
- [0048 — Status-bar click popups](0048-status-bar-click-popups.md)
- [0049 — Nonmodal model picker](0049-nonmodal-model-picker.md)
- [0050 — Bounded global AI knowledge cleanup](0050-bounded-global-knowledge-cleanup.md)
- [0051 — Read-only Claude reset grants](0051-claude-reset-grants.md)
- [0052 — Owned LSP control in Desktop and TUI](0052-owned-lsp-control.md)
- [0053 — Repository-only commit author in Source Control](0053-repository-commit-author.md)
- [0054 — Project-shared LSP ownership](0054-project-shared-lsp.md)
- [0055 — Temporary, isolated BTW side chat](0055-temporary-btw-side-chat.md)
- [0056 — Monitoring-only LSP panels](0056-lsp-monitoring.md)
- [0057 — Canonical LSP reuse and bounded idle retention](0057-lsp-reuse-idle-cleanup.md)

Workflow contract: [repository knowledge workflow](../../specs/repo-knowledge-agent-workflow.md).
