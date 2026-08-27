# Spec: Browser QA form-auth scaffold

## Type

Change

## Goal

Let the browser-QA sub-agent prepare a target-specific form-auth configuration
without reading, writing, receiving, or printing credential values. The user
should only need to replace clearly marked secret placeholders.

## Scope

- Add a trusted runner command that inspects a public login form.
- Generate `.pi/qa_auth.jsonc` with discovered field and submit selectors.
- Keep generated values as non-secret placeholders until the user edits them.
- Preserve the rule that agents never read or edit `.pi/qa_auth.jsonc`.

## Non-goals

- Collecting credentials interactively through the agent.
- Guessing cookie, token, storage-state, MFA, or federated-login credentials.
- Modifying an existing non-empty auth configuration.

## Behavior

- `auth scaffold` requires a project-local browser-QA sub-agent workspace, an
  HTTPS login URL (or loopback HTTP for local development), and a safe profile
  id.
- The trusted runner opens the unauthenticated login page with fail-closed
  origin routing and discovers the most likely login form, fillable fields,
  submit control, and form container.
- It writes a private `0600` `.pi/qa_auth.jsonc` containing only generated
  selectors and `__PI_QA_SECRET_n__` placeholders. It may replace the runner's
  empty generated template, but never a non-empty profiles object.
- By default, successful login means that the discovered form becomes hidden.
  A form-less page requires an explicit success URL pattern or selector/state.
- A run cannot use a profile while generated placeholders remain. The runner
  returns `QA_AUTH_UPDATE_REQUIRED` without exposing selectors or values.

## Invariants

- No credential value is accepted through command arguments or environment
  variables.
- Scaffold status output contains only path, profile id, counts, and action.
- The command never prints inspected DOM text, input values, URLs, or selectors.
- Agents continue to treat `.pi/qa_auth.jsonc` as opaque and user-owned.

## Edge cases

- Reject pages without a discoverable fillable field or submit control, and
  form-less pages without an explicit success condition.
- Reject remote plain-HTTP login pages.
- Reject cross-origin base URLs and malformed success options.
- Reject symlinked or permissive auth paths.
- Refuse to overwrite invalid or non-empty auth configuration.

## Related files

- `scripts/browser-qa-runner.mjs`
- `../SKILL.md`
- `../../../../../test/async-subagents/browser-qa-runner.test.ts`

## Verification

- Unit tests for discovery output, placeholder blocking, private permissions,
  empty-template replacement, and non-empty-config refusal.
- Existing browser-QA runner tests and repository checks continue to pass.

## Evidence

- Confirmed by code: current runner owns Playwright, origin isolation, private
  auth-file creation, validation, and redacted status output.
- Confirmed by tests: current runner rejects permissive/symlinked auth files and
  creates its empty template with private permissions.
- Confirmed by docs: the private skill forbids agents from reading or editing
  `.pi/qa_auth.jsonc`.
