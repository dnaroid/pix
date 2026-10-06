# 0053 — Repository-only commit author in Source Control

- Status: accepted
- Recorded: 2026-10-05
- Decided: 2026-10-05
- Owner / approval evidence: user requested the existing local name/email setting in the Git panel after selecting `dnaroid <dnaroid@gmail.com>` for this repository.
- Affected specs: [Desktop Source Control workflows](../../specs/desktop-git-workflows.md)
- Supersedes: none
- Superseded by: none

## Context

The user's inherited Git identity was corporate; they selected a personal identity
for this repository and asked to expose that setting in Source Control. Git author
metadata and remote authentication are distinct. Evidence: Git's effective/local
config is already used by ordinary commit commands. Assumption: this panel action
should preserve the repository-only scope established in the conversation, not
silently change every corporate repository.

## Decision

Add a compact collapsed Commit author disclosure with name/email, source labels,
explicit repository-only Save and Reload. Do not add global editing, login/account
management, identity presets or history rewriting. Save through the shared Git
mutation lock and update both common-config keys atomically under `config.lock`;
preserve unrelated configuration and permissions. Read back effective Git config
after save because included/worktree settings may affect precedence. Treat
environment overrides as outside this editor's displayed configuration.

## Alternatives considered

- Global Git editing: risks leaking personal identity into corporate repositories.
- Two independent `git config --local` writes: a second-write failure could leave
  a mixed corporate/personal identity.
- Full settings dialog or account picker: broader UI and authentication scope
  than the requested repository setting.

## Consequences

The UI owns only a disposable workspace-bound draft; asynchronous completions are
guarded and saves are serialized with commits. Locked or unwritable config has
explicit error feedback and leaves existing config intact. Linked worktrees share
the common repository setting; worktree-specific overrides remain authoritative.
No global identity reset/removal control is introduced.

## Revisit triggers

Revisit if users request global identity management, repository presets, explicit
worktree-specific settings, environment-override visibility or authentication
account switching. None is implied by this change.
