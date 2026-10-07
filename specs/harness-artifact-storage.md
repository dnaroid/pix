---
kind: spec
status: active
---

# Harness disposable artifact storage

## Behavior

Harness instructions direct disposable task output (test logs, scratch reports,
mockups and captures) to unique task/run locations under the current project's
`.pi/artifacts/`. They forbid project-root `artifacts/` and `.artifacts/` for
agent scratch output. Shell/Bash aliases share the same log-path guidance.
Code-generated prompts and eval defaults use `PROJECT_ARTIFACTS_DIR` from
`external/pi-tools-suite/src/artifact-paths.ts`, not separate path literals.
The relative path is constant; absolute workspace paths are not cached.

Desktop sessions (`PIX_CONFIG_PROFILE=desktop`, trimmed and case-insensitive)
also receive concise English system-prompt guidance to prefer SVG files over
pseudo/ASCII art for visual explanations (diagrams, layouts and mockups), save
them under the current project's `.pi/artifacts/`, and return a clickable
Markdown file link. Explicit user-requested formats or locations take precedence.
This host guidance is independent of model-specific discipline and optional
suite tools; it is not injected into TUI, standalone Pi or other ACP hosts.
The hook preserves existing structured sections and earlier opaque prompt
overrides, without duplicating its hint or caching absolute workspace paths.
When showing or reporting images, including screenshots and QA evidence, the
guidance requires an explicit Markdown link for each image with its full
project-relative destination, not a directory link followed by bare or inline-code
filenames. It includes an example and explains that supported local image links
render as clickable inline previews in Desktop (see
[Desktop Markdown rendering](desktop-markdown-rendering.md)). Existing evidence
locations, including `.pi/subagents/`, are preserved; media outside the project
use absolute paths or absolute `file://` Markdown destinations. Video links expose
inline playback controls.

The six eval report entrypoints, including the paired Todo prompt runner, share
one resolver. It starts from cwd, uses
the nearest ancestor containing `.pi` or `.git` (directory or Git worktree
marker file), and falls back to cwd if none exists. Defaults are
`.pi/artifacts/evals/<runner>-<timestamp>-<uuid>/`, resolved against that project.
The helper only resolves paths; report writers create their own directories.
Explicit `PI_TOOLS_SUITE_EVAL_OUTPUT_DIR` and `DELIVERY_REVIEW_OUTPUT` overrides
remain supported; relative overrides resolve against cwd.

New prompts, role profiles, examples and harness defaults must preserve the
policy. `AGENTS.md` and the suite README carry authoring guidance. A custom
`promptOverride` still replaces the base prompt verbatim: its author must include
the policy rather than relying on the generic prompt being appended.

Decision: [0015 — Canonical disposable harness output](../docs/decisions/0015-harness-artifact-storage.md).

## Constraints and failure cases

- Harness-managed subagent/QA evidence stays under `.pi/subagents/`.
- Installed UI-QA helper executables are infrastructure, not disposable evidence.
  The macOS development helper lives under the OS user's
  `~/Library/Application Support/Pix/ui-qa/helpers/`, outside project Registry
  cleanup. Do not recreate `.pi/ui-qa/` as a persistent installation: it is a
  non-canonical project directory and can be removed. See `specs/ui-qa-agent.md`.
- Explicit release/build pipelines retain `.artifacts/` paths. User-requested
  durable deliverables go to the requested location, not disposable storage.
- This is guidance plus eval defaults, not a filesystem sandbox. Explicit
  output overrides can point elsewhere and are not cleaned by this policy.
- Existing artifacts are not moved or deleted. Prior provenance may be unknown.
- No new cleanup mechanism is introduced. The
  [Registry storage contract](resource-registry-project-state.md) cleans
  initialized-project `.pi/artifacts/` and `.pi/subagents/` in Desktop after a
  72-hour background TTL; manual Clean is immediate. This is not guaranteed
  in standalone Pi or uninitialized projects. Export evidence needing retention.
- Runtime mirrors are generated from authoritative suite sources; do not fix
  an installed/generated prompt copy independently of its source.

## Implementation

- `AGENTS.md`
- `external/pi-tools-suite/src/artifact-paths.ts`
- `external/pi-tools-suite/src/desktop-visual-prompt.ts`
- `external/pi-tools-suite/src/index.ts`
- `external/pi-tools-suite/src/tool-descriptions.ts`
- `external/pi-tools-suite/src/async-subagents/core/prompt.ts`
- `external/pi-tools-suite/test/evals/harness/output-dir.ts`
- `external/pi-tools-suite/test/evals/run-evals.ts`
- `external/pi-tools-suite/test/evals/run-p01n-paired.ts`
- `external/pi-tools-suite/test/evals/run-todo-paired.ts`
- `external/pi-tools-suite/test/evals/todo-prompt-snapshots.ts`
- `external/pi-tools-suite/test/evals/delivery-review/live.test.ts`

## Tests

- `external/pi-tools-suite/test/tool-descriptions.test.ts`
- `external/pi-tools-suite/test/async-subagents/core.test.ts`
- `external/pi-tools-suite/test/evals/output-dir.test.ts`
- `external/pi-tools-suite/test/evals/todo-conciseness.test.ts`
- `external/pi-tools-suite/test/desktop-visual-prompt.test.ts`

## Verification

Run the five focused Bun test files above and suite source typecheck.
Assertions cover log guidance on shell/Bash aliases, generic child prompts,
project-relative eval paths, unique run directories and explicit overrides.
Check generated runtime/live synchronization and review task-scoped knowledge
against sources. Live model evals are a separate empirical prompt-compliance
check, not implied by deterministic prompt tests.
