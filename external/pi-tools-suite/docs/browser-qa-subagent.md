# Browser QA sub-agent specification

## Goal

Provide a cheap, fast `browser-qa` async-subagent that reproduces browser bugs
and proves fixes with deterministic assertions plus screenshot, video, and trace
evidence. The role uses `openai-codex/gpt-5.4-mini`, falling back to
`antigravity/gemini-3-flash-preview` and then `zai/glm-5.3`.

## Private skill isolation

- The browser QA skill lives under `src/async-subagents/private-skills/`, outside
  Pi's normal skill discovery roots.
- Sub-agent processes disable normal extension discovery, then always load the
  suite's model-tools and Antigravity provider extensions explicitly, regardless
  of the selected model. This keeps the process isolated without making any
  Antigravity-backed role unavailable.
- A type profile may declare `isolatedSkills`. Spawning that profile adds
  `--no-skills` followed by one explicit `--skill` per configured path.
- The `browser-qa` profile always loads one self-contained private workflow.
  Relevant browser-test design guidance is bundled beside its trusted runner;
  no separately discovered skill or browser CLI is required. Configuration may
  append isolated skills but cannot remove the mandatory private workflow.
- Other sub-agent profiles and the parent session must not discover the private
  skill automatically.

## Authentication contract

- Public browser QA requires no auth profile and does not create or require
  `.pi/qa_auth.jsonc`. Its explicit base URL supplies the one exact allowed
  origin, and the runner still blocks every other HTTP(S)/WebSocket origin.
- Auth profiles live in project-local `.pi/qa_auth.jsonc` and are selected by
  explicit id. The file must be a real project-local file with mode `0600` on
  POSIX. Profile listings expose only `id`, description, and traits.
- Listing profiles when the file is absent returns an empty list without side
  effects. When authenticated QA explicitly requests credentials and that file
  is absent, the runner creates a private empty template and returns
  `provide_credentials`.
  The sub-agent must explicitly ask the user to fill the reported file and
  rerun QA; it must not read or edit the credential values itself.
- Every profile requires one or more exact `allowedOrigins`. Secret-bearing auth
  is applied only to those origins; all other HTTP(S)/WebSocket traffic and
  service workers are blocked during QA.
- Supported auth types are `form`, `cookie`, `localStorage`, `sessionStorage`,
  `bearer`, and existing Playwright `storageState`.
- The bundled runner reads secrets internally. Credentials must never be copied
  into prompts, generated QA flows, shell arguments, transcripts, reports,
  or QA evidence.
- Generated browser state is private cache under `.pi/qa-auth-state`. Ephemeral
  flows, evidence, and result manifests are written under the owning agent's
  `.pi/subagents/<run>/<agent-id>/browser-qa/` workspace. Multiple profiles use
  separate browser contexts/evidence directories, and normal sub-agent shutdown
  or cleanup removes the whole workspace with its run.
- Missing, rejected, or expired explicitly selected auth returns a
  machine-readable update-required status naming only the profile id, config
  file, and redacted reason. The parent asks the user to update the file and
  reruns; there is no `/qa-auth` command.

## QA execution contract

- A model-authored QA flow is declarative JSONC, not executable JavaScript. The
  trusted runner implements a bounded set of navigation, interaction,
  assertion, screenshot, and auth-rejection actions and never gives the flow a
  Playwright context or credential values.
- The launcher injects `PI_SUBAGENT_AGENT_DIR`, pre-creates a private
  `browser-qa/flows/` workspace, and clears stale browser QA files when an agent
  id is reused. The runner validates the directory's project/type metadata and
  refuses flows outside it; the model cannot select a shared evidence root.
- The runner owns browser lifecycle, origin checks, auth application, tracing,
  screenshots, video finalization, and redacted result output. Before retaining
  a trace it removes network/non-image resource entries, redacts configured and
  runtime storage credentials, and verifies those values are absent.
- Success and post-launch failure results include typed artifact groups. Every
  item has an absolute filesystem path and a `file:` URI; the sub-agent must
  present each item as a clickable Markdown link instead of reporting only the
  evidence directory.
- Success requires deterministic assertions. Visual inspection supplements,
  but never replaces, explicit expected-state checks.
- Auth rejection discovered by a QA flow is reported through the
  `authRejectedIf` action so the parent gets an update-required status.

## Acceptance criteria

1. `browser-qa` resolves to the intended model/fallback and its self-contained
   private workflow, and its isolated child process can register the configured
   Antigravity model.
2. Spawn args contain `--no-skills` and the mandatory private skill for this
   profile; ordinary profiles retain existing skill discovery behavior.
3. Auth profile listing and all error output are redacted; model-authored input
   cannot execute code in the credential-bearing process.
4. Runner tests cover public execution without an auth file, explicit profile
   selection, all auth modes, fail-closed origins, path/mode hardening, private
   empty-template creation only on an explicit auth request, non-executable
   flows, and successful redacted evidence creation.
5. Browser QA flows/evidence live only inside the owning sub-agent directory;
   deleting the run removes them while persistent auth config/state remains.
6. Completed test runs report clickable screenshot, video, and trace links
   whenever those artifacts exist.
7. Suite tests/typecheck, host checks, and suite sync pass.

## Real-browser regression test

The repository includes a local mock-page E2E that launches real Chromium and
asserts PNG screenshots, WebM video, sanitized trace output, and absolute
path/`file:` URI metadata:

```bash
npx playwright install chromium
npm run test:browser-qa-e2e
```

Normal suite tests keep this case skipped; the Publish workflow runs it on
Linux after installing Chromium. The runner writes into a temporary simulated
sub-agent directory. For manual inspection only, explicit E2E runs copy the
latest artifacts to `.pi/qa-runs/browser-qa-e2e/latest/` and print clickable
links; this test-only published copy is not the runtime storage contract. Set
`BROWSER_QA_KEEP_EVIDENCE=0` to skip that copy.
