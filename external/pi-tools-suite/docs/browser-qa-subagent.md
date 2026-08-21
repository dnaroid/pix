# Browser QA sub-agent specification

## Goal

Provide a cheap, fast `browser-qa` async-subagent that reproduces browser bugs
and proves fixes with deterministic assertions plus screenshot, video, and trace
evidence. The role uses `antigravity/gemini-3-flash-preview`, falling back to
`openai-codex/gpt-5.4-mini`.

## Private skill isolation

- The browser QA skill lives under `src/async-subagents/private-skills/`, outside
  Pi's normal skill discovery roots.
- A type profile may declare `isolatedSkills`. Spawning that profile adds
  `--no-skills` followed by one explicit `--skill` per configured path.
- Other sub-agent profiles and the parent session must not discover the private
  skill automatically.

## Authentication contract

- Auth profiles live in project-local `.pi/qa_auth.jsonc` and are selected by
  explicit id. The file must be a real project-local file with mode `0600` on
  POSIX. Profile listings expose only `id`, description, and traits.
- Every profile requires one or more exact `allowedOrigins`. Secret-bearing auth
  is applied only to those origins; all other HTTP(S)/WebSocket traffic and
  service workers are blocked during QA.
- Supported auth types are `form`, `cookie`, `localStorage`, `sessionStorage`,
  `bearer`, and existing Playwright `storageState`.
- The bundled runner reads secrets internally. Credentials must never be copied
  into prompts, generated QA flows, shell arguments, transcripts, reports,
  or QA evidence.
- Generated browser state is private cache under `.pi/qa-auth-state`; evidence
  is written under `.pi/qa-runs`. Multiple profiles always use separate browser
  contexts and evidence directories.
- Missing, ambiguous, rejected, or expired auth returns a machine-readable
  update-required/profile-required status naming only the profile id, config
  file, and redacted reason. The parent asks the user to update the file and
  reruns; there is no `/qa-auth` command.

## QA execution contract

- A model-authored QA flow is declarative JSONC, not executable JavaScript. The
  trusted runner implements a bounded set of navigation, interaction,
  assertion, screenshot, and auth-rejection actions and never gives the flow a
  Playwright context or credential values.
- The runner owns browser lifecycle, origin checks, auth application, tracing,
  screenshots, video finalization, and redacted result output. Before retaining
  a trace it removes network/non-image resource entries, redacts configured and
  runtime storage credentials, and verifies those values are absent.
- Success requires deterministic assertions. Visual inspection supplements,
  but never replaces, explicit expected-state checks.
- Auth rejection discovered by a QA flow is reported through the
  `authRejectedIf` action so the parent gets an update-required status.

## Acceptance criteria

1. `browser-qa` resolves to the intended model/fallback and private skill.
2. Spawn args contain `--no-skills` and only the explicit private skill for this
   profile; ordinary profiles retain existing skill discovery behavior.
3. Auth profile listing and all error output are redacted; model-authored input
   cannot execute code in the credential-bearing process.
4. Runner tests cover explicit profile selection, all auth modes, fail-closed
   origins, path/mode hardening, non-executable flows, and successful redacted
   evidence creation.
5. Suite tests/typecheck, host checks, and suite sync pass.
