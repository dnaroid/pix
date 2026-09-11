# TUI Git assistant slash commands

<!-- markdownlint-disable MD013 -->

## Type

Change

## Lifecycle

Active implemented contract.

## Goal

Expose Pix's existing Git review and commit-message helper workflows directly in the terminal renderer without turning either workflow into an implicit model prompt or an unconfirmed repository mutation.

## `/code-review`

- `/code-review` is a Pix-owned builtin slash command and accepts no arguments. `[confirmed by code: src/app/commands/command-registry.ts]`
- The command is available only while the active Pi session is idle. It resolves the repository root with `git rev-parse --show-toplevel`; running it outside a Git repository fails through the normal slash-command error path. `[confirmed by code: src/app/commands/command-git-actions.ts]`
- Review input contains tracked staged changes, tracked unstaged changes, and untracked files. Staged and unstaged tracked changes use `git diff` with `--no-ext-diff --no-color --minimal`. `[confirmed by code]`
- Untracked regular text files are represented as added-file content. Binary files are identified without decoding their contents; symbolic links are represented by link target rather than following the link; non-regular files and individual files over 128 KiB are omitted with an explanatory marker. `[confirmed by code]`
- The aggregate review input is bounded to 200,000 characters. `[confirmed by code]`
- The configured review model returns concise Markdown findings; Pix adds the result as a local system entry and does not append a model prompt to the active Pi session. `[confirmed by code]`

## `/commit-message`

- `/commit-message` is a Pix-owned builtin slash command and accepts no arguments. `[confirmed by code: src/app/commands/command-registry.ts]`
- It reads **staged changes only** with `git diff --cached`; unstaged and untracked changes do not contribute to the generated message and are not staged automatically. `[confirmed by code: src/app/commands/command-git-actions.ts]`
- With no staged diff, Pix reports that there is nothing staged and does not call the model or `git commit`. `[confirmed by code]`
- After generation, Pix shows the complete commit message in the conversation and opens a non-searchable confirmation menu. No commit occurs unless the user selects `Commit staged changes`. `[confirmed by code]`
- Before committing, Pix reads the staged diff again and requires exact equality with the diff used for generation. If the staged set changed while the confirmation UI was open, the commit is refused and the user must run `/commit-message` again. `[confirmed by code]` `[confirmed by tests: tests/command-git-actions.test.ts]`
- A confirmed commit runs `git commit -F -` in the repository root and passes the generated message over stdin. Pix does not shell-interpolate the message, auto-stage files, bypass hooks, or add `--no-verify`. `[confirmed by code]` `[confirmed by tests]`
- Successful Git output is shown as a local system entry. Git failures propagate through the normal command error path. `[confirmed by code]`

## Model configuration

- TUI Git helpers intentionally reuse the existing `desktop.git` configuration keys for compatibility: `reviewModelRef` + `reviewFallbackModels`, and `commitMessageModelRef` + `commitMessageFallbackModels`. The namespace name is legacy; both Desktop and TUI consume these values. `[confirmed by code: src/app/commands/command-git-actions.ts, acp/src/acp/git-assistant.ts]`
- Project `.pi/pix.jsonc` values override user `~/.config/pi/pix.jsonc` values. An omitted project fallback array inherits the user fallback chain; an explicitly configured empty array clears it. Candidate refs are de-duplicated in order. `[confirmed by code]` `[confirmed by tests: tests/command-git-actions.test.ts]`
- Defaults remain `openai-codex/gpt-5.6-luna:medium` for review and `openai-codex/gpt-5.6-luna:minimal` for commit-message generation. `[confirmed by code: src/default-pix-config.ts, src/app/commands/command-git-actions.ts]`
- Model execution uses a longer default deadline for code review than for commit-message generation: review gets 120 seconds, while commit-message generation remains at 45 seconds. Desktop ACP and TUI use the same split. `[confirmed by code: acp/src/acp/git-assistant.ts, src/app/commands/command-git-actions.ts]`

## Non-goals

- `/commit-message` does not stage, amend, push, or bypass Git hooks.
- The confirmation menu does not edit the generated commit message; cancel and rerun when a different message is wanted.
- `/code-review` does not modify the working tree or index.

## Related files

- `src/app/commands/command-git-actions.ts`
- `src/app/commands/command-controller.ts`
- `src/app/commands/command-registry.ts`
- `tests/command-git-actions.test.ts`
- `tests/command-registry.test.ts`
- `tests/slash-command-parity.test.ts`
- `src/default-pix-config.ts`
- `src/schemas/pix-schema.ts`
- `acp/src/acp/git-assistant.ts`
- `specs/model-selector-fallbacks.md`

## Verification

- Root TypeScript typecheck passes.
- Focused command tests cover registration, confirmed commit, staged-diff race refusal, all review input classes, and model fallback inheritance/replacement.
- Slash-command parity treats `/code-review` and `/commit-message` as TUI commands with existing Desktop UI equivalents rather than requiring duplicate Desktop slash commands.
- Generated Pix JSON schema must remain synchronized with `src/schemas/pix-schema.ts`.
