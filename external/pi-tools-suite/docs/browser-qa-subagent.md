# Browser QA sub-agent specification

## Goal

Provide a cheap, fast `browser-qa` async-subagent that reproduces browser bugs
and proves fixes with deterministic assertions plus screenshot, video, and trace
evidence. The role uses `zai/glm-5.3-flash`, falling back to
`openai-codex/gpt-5.6-luna`.

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
- Target discovery is a bounded preflight, not an open-ended research task. The
  sub-agent invokes the runner within 45 seconds or returns `BLOCKED`; it does
  not spend the full launcher budget reading source or probing prerequisites.
- The launcher injects `PI_SUBAGENT_AGENT_DIR`, pre-creates a private
  `browser-qa/flows/` workspace, and clears stale browser QA files when an agent
  id is reused. The runner validates the directory's project/type metadata and
  refuses flows outside it; the model cannot select a shared evidence root.
- The runner owns browser lifecycle, origin checks, auth application, tracing,
  screenshots, video finalization, and redacted result output. Before retaining
  a trace it removes network/non-image resource entries, redacts configured and
  runtime storage credentials, and verifies those values are absent.
- After every navigation or visible interaction, the runner waits for DOM
  readiness, completion of requests started by the action, and disappearance of
  common visible busy/spinner/skeleton markers. It requires a 500 ms stable
  interval before the next action so recordings remain readable; a page that
  stays busy through the flow timeout fails closed instead of being tested as a
  loading shell. App-specific readiness still requires an explicit declarative
  wait/assertion in the authored flow.
- Before any page is created, the runner installs a context-wide, isolated
  interaction visualizer. Recorded clicks/double-clicks show a transient cursor
  and pulse. Native drag/drop is replayed for 450 ms with a large orange cursor,
  progressively drawn high-contrast path, and green drop marker. It also covers
  same-origin frames, declared popups, and form-auth submission. The layer is
  accessibility-hidden, pointer-transparent, never cancels application events,
  and its bounded animations clear within the post-action stable interval.
- Success and post-launch failure results include typed artifact groups. Every
  item has an absolute filesystem path and a `file:` URI; the sub-agent must
  present each item as a clickable Markdown link instead of reporting only the
  evidence directory.
- Success requires deterministic assertions. Visual inspection supplements,
  but never replaces, explicit expected-state checks.
- Auth rejection discovered by a QA flow is reported through the
  `authRejectedIf` action so the parent gets an update-required status.

## Reliability and shutdown contract

- The built-in `browser-qa` profile has a 120-second wall-clock budget unless
  the caller explicitly supplies a task or spawn timeout. This bounds model
  stalls as well as browser work.
- The trusted runner has its own bounded lifecycle. Browser launch, context
  setup, auth, flow execution, evidence finalization, and browser shutdown must
  not wait forever; a timeout reports the last started stage without exposing
  flow contents or credentials.
- Trace sanitization runs in a memory-limited worker that can be terminated at
  the cleanup deadline; synchronous archive work cannot defeat the watchdog.
- The launcher always writes a small sanitized `progress.jsonl` journal in the
  agent directory. It records lifecycle/RPC event types and tool names, but not
  prompts, tool arguments, tool results, model text, or secrets. The browser
  runner writes similarly sanitized stage entries under its private workspace.
- On POSIX, newly launched agents own a process group. Settled, timed-out, and
  explicitly stopped agents signal that group rather than only the Pi process;
  timeout/settled shutdown escalates to `SIGKILL` after its grace period. On
  Windows the existing recursive `taskkill /T /F` behavior remains in force.
- Process-tree cleanup is scoped to a launcher-created process-group marker so
  an old or externally-created PID is never treated as an owned process group.
  User browser sessions outside that group must not be signalled.
- Playwright can launch Chromium in its own POSIX process group. On runner
  failure the runner snapshots and kills only its own descendants before it
  exits, covering that detached browser tree without touching a user's browser.

## Acceptance criteria

1. `browser-qa` resolves to the intended model/fallback and its self-contained
   private workflow, and its isolated child process can register the configured
   model provider.
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
6. Runner tests prove that network activity and visible loading indicators are
   awaited, persistent loading fails the flow, visible actions retain a stable
   500 ms video interval, and context-wide click/drag video visualization is
   installed with bounded click pacing.
7. Completed test runs report clickable screenshot, video, and trace links
   whenever those artifacts exist.
8. Timeout tests identify the last browser stage, launcher progress remains
   available when full RPC logging is disabled, and process-tree tests prove a
   descendant is terminated without signalling unrelated processes.
9. Suite tests/typecheck, host checks, and suite sync pass.

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
