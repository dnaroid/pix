# UI QA sub-agent specification

## Type

As-is

## Lifecycle

Active implemented contract.

## Goal

Provide a cheap, fast `ui-qa` async-subagent that reproduces user-visible bugs
and proves fixes across browser/web UI, terminal/TUI applications, and native
desktop GUIs. Browser QA keeps deterministic assertions plus screenshot, video,
and trace evidence through the existing trusted runner; native/TUI QA uses a
real PTY or deterministic app/platform UI driver and retains inspectable
captures plus automatic bounded video evidence when the backend supports it.
Its ranked `models` list prefers `zai/glm-5.3-flash`, then
`openai-codex/gpt-5.6-luna`, filtered by the active preset's model pool and
confirmed runtime image support.

## Inline agent workflow and skill isolation

- The bundled role is a thin common contract: `src/async-subagents/agents/ui-qa.md`
  keeps only the shared invariants (real target, backend classification,
  `BLOCKED` semantics, deterministic-assertion oracle, bounded execution, owned
  cleanup, private evidence, credential opacity) plus the guide-routing and
  probe/run invocation syntax. Its body becomes the QA child's `promptAppend`
  through the shared agent loader. Parent and router catalogs include only its
  short `description`.
- Backend-specific instructions live in the canonical resource tree under
  `src/async-subagents/agents/ui-qa/guides/`: `browser.md`, `tui.md`,
  `desktop.md`, and the explicit `browser-auth.md` companion. The child loads
  exactly the matching guide before any UI action through the read-only runner
  command `node "$PI_UI_QA_RUNNER" guide --backend browser|tui|desktop`
  (plus `--topic auth` for browser authentication). The command resolves its
  bundled files from a fixed allowlist, rejects unknown backends/topics,
  unknown options, extra arguments, and traversal, bounds guide size, and
  prints only the requested document; the model never composes or reads the
  source path itself. Browser runs do not receive TUI/desktop text and vice
  versa, and the auth guide is loaded only when authentication is actually
  required.
- The capability-first runner lives under
  `src/async-subagents/agents/ui-qa/`, with browser, PTY/TUI, and macOS
  accessibility backends. The trusted browser runner, vendor
  dependencies/licenses, and optional legacy JSONC examples are colocated
  under `agents/ui-qa/browser/`; none of these assets, including the guides,
  is a discoverable skill or agent role (`agents/*.md` discovery stays
  non-recursive and top-level only).
- Sub-agent processes disable normal extension discovery, then always load the
  suite's model-tools extension. They load the Antigravity provider extension
  only when an Antigravity model is explicitly selected. The launcher appends
  `--models <effective-model>` after forwarded arguments so persisted model
  patterns cannot resolve unrelated providers inside the isolated child.
- Every async sub-agent launches with `--no-skills`. `--skill` and
  `--skill=...` flags are removed from `extraArgs`, and role profiles have no
  skill-loading field. The thin agent Markdown plus its on-demand bundled
  guides are the complete role instruction source.
- Explicit legacy `browser-qa` tasks normalize to `ui-qa`; a project-local
  `browser-qa.md` profile override is migrated onto the canonical `ui-qa`
  profile during config loading. Installed browser resources are part of the
  canonical `ui-qa` tree, while the private runtime workspace keeps its
  historical `browser-qa/` name for compatibility.
- The launcher sets `PI_UI_QA_RUNNER` to the absolute capability-first runner
  and `PI_BROWSER_QA_RUNNER` to its trusted browser backend, replacing inherited
  values and stripping both from ordinary children. QA uses the unified runner
  for backend probe/run and the browser runner directly only for credential
  profile discovery or form-auth scaffolding.
- Model-only profile overrides inherit the workflow. An explicit profile
  `promptAppend` replaces the body like any other agent profile; it is not an
  immutable security boundary. Runtime protections remain in the runner, and
  the thin prompt's guide-routing requirement does not weaken them: every
  backend action still goes through the runner's fail-closed checks.

## Browser authentication contract

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

## Native/TUI execution contract

- The QA target must be the actual user-facing TUI or desktop application named
  by the task. Repository tests, snapshots, source inspection, or a different
  CLI/web surface may support discovery but cannot substitute for requested UI
  execution.
- The launcher creates a private `ui-qa/` workspace under the owning agent
  directory. Native/TUI transcripts, captures, screenshots, videos, and small
  temporary driver artifacts stay there and are removed with the sub-agent run.
- Repeated unnamed Desktop evidence steps receive collision-free filenames
  based on their action and step index. Explicit names remain available when a
  stable human-readable artifact label is useful.
- Terminal/TUI verification is selected from `target.command`, with an explicit
  presentation contract that is independent of project/app identity.
  New QA flows choose presentation explicitly by surface category: `pty` is for
  line-oriented/plain terminal/CLI programs or protocol-focused semantic tests,
  while `native-terminal` is the normal presentation for structured/full-screen
  TUIs. Omitted presentation remains a `pty` compatibility default for older
  flows only. Native-terminal covers real-window colors, fonts/glyphs, special
  symbols, wrapping, clipping, menus/focus, and pixel geometry.
  The target still runs in the runner-owned PTY used for deterministic input and
  semantic assertions; the runner mirrors that same raw PTY byte stream through
  a private authenticated local bridge into a fresh owned native terminal host,
  whose real window supplies screenshots/video. The bridge bootstrap never
  contains the target argv/cwd/env. On macOS the native-terminal provider is
  discovered from the environment, not from the project: installed iTerm2 is
  preferred so evidence uses its configured colors/font/glyph rendering, with
  Terminal.app as the built-in fallback.
  Selection is based on required capabilities/evidence, never a repository-
  specific heuristic. If pixel fidelity is required but native-terminal control
  is unavailable, the result is `BLOCKED`; the runner does not silently
  substitute a headless replay.
- The target in either TUI presentation may use its normal explicit
  project/session arguments to open deterministic state before assertions.
  Non-interactive stdout from another CLI path is not TUI verification.
  Automated input in both presentations goes to the same owned PTY, and native-
  terminal host stdin/protocol responses are bridged back to it; flows wait for
  expected text or a stable frame after `sendText`/`sendKeys` before asserting
  or capturing the resulting state.
- Native desktop verification is selected from `target.application`. The
  bundled macOS accessibility/window backend is used when its required
  permissions are already available; unsupported platforms or missing
  capabilities return `BLOCKED`. The agent must not install UI automation
  dependencies, change OS privacy/accessibility permissions, disable sandboxing,
  or operate unrelated user windows.
- PTY-presentation runs automatically retain a bounded asciicast v2 replay in
  `artifacts.videos`. It is generated from timestamped PTY output and resize
  events, capped at 1 MiB, and is explicitly terminal-state replay rather than
  pixel evidence. Native-terminal presentation instead retains real-window
  screenshots and, when exact-window capture is available, a bounded MP4 from
  the owned native terminal host; its asciicast/headless captures remain
  diagnostic-only and are never promoted as proof of colors/glyphs/window
  geometry.
- When macOS 12.3+ ScreenCaptureKit and Screen Recording permission are
  available, desktop runs automatically retain a silent H.264 MP4 of only the
  correlated application window. Independent-window capture scales to fill the
  Retina encoder surface so the application occupies the complete video frame
  rather than a top-left subset with unused canvas. Recording is capped at 30
  seconds, has no display/region fallback, and is best-effort: an unavailable
  video is reported as a structured observation rather than an assertion
  failure.
- Pass/fail requires a deterministic product-visible oracle such as terminal
  content/state, accessibility/app-driver control state, window/dialog state,
  visible copy, enabled/checked/value state, or another explicit application
  result. Screenshots explain the result but are not the sole oracle.
- When no safe deterministic PTY/GUI control path is available, the correct
  result is `BLOCKED`; static tests are not promoted to UI QA evidence.
- Cleanup is ownership-scoped: terminate only the PTY/session/app/driver process
  created by the run, never all processes with a matching application name.
  POSIX desktop launch contracts correlate and clean up the complete detached
  process group, so a package-manager wrapper may hand off to its GUI descendant
  without making that app unreachable or leaving it running. Windows remains
  PID-based until its native driver provides an equivalent group primitive.

## Unified capability-first runner contract

- One private JSONC flow under the owning agent's `ui-qa/flows/` declares
  exactly one browser URL, TUI command, or desktop application target. `probe`
  reports deterministic candidate capabilities and selects the matching backend;
  `run` executes that same bounded flow. The child keeps the flow at mode `0600`
  on POSIX before either command, matching the runner's private-path checks.
- Browser execution adapts the unified target and steps to the existing trusted
  browser runner, preserving its auth, origin, evidence, and cleanup boundary.
- TUI execution launches only a bounded project-local/package-runtime contract
  through a real PTY, models ANSI/VT alternate-screen state with a headless
  terminal, and supports text, cursor, process, resize, stability, and capture
  assertions.
- On macOS, desktop execution uses a bundled compiled Accessibility/CGWindow
  helper for semantic window/control actions, state assertions, accessibility
  snapshots, screenshots, and automatic exact-window ScreenCaptureKit video.
  Explicit PID lookup must observe GUI processes that register after the helper
  starts. Runner-owned POSIX launches use process-group lookup to find the GUI
  descendant behind package-manager wrappers. Unsupported platforms or missing
  required control capabilities return a structured `BLOCKED` result;
  unavailable best-effort video is reported as an observation without replacing
  deterministic assertions.
- Results normalize selection rationale, assertions, observations, and typed
  artifact groups across all backends. `BLOCKED` additionally normalizes a
  parent-facing `blockedHandoff` containing the selected backend/platform
  driver, missing capabilities, concrete reason, remediation string,
  `manualActionRequired: true`, and
  `automaticRemediationAttempted: false`. This handoff is the installation/
  permission/platform-repair reference for the parent; the QA child relays it
  and never performs those environment changes itself. Every runner/app/helper
  process has a bounded deadline and cleanup is limited to processes launched by
  that run.

## Browser backend execution contract

- A model-authored QA flow is declarative JSONC, not executable JavaScript. The
  trusted runner implements a bounded set of navigation, interaction,
  assertion, screenshot, and auth-rejection actions and never gives the flow a
  Playwright context or credential values.
- Target discovery is a bounded preflight, not an open-ended research task. The
  sub-agent invokes the runner within 45 seconds or returns `BLOCKED`; it does
  not spend the full launcher budget reading source or probing prerequisites.
- The launcher injects `PI_SUBAGENT_AGENT_DIR`, pre-creates private `ui-qa/` and
  `browser-qa/flows/` workspaces, and clears stale UI/browser QA files when an
  agent id is reused. The runner validates the directory's project/type
  metadata and refuses flows outside it; the model cannot select a shared
  evidence root.
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

- The built-in `ui-qa` profile has a 300-second wall-clock budget unless
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

## Related files

- `external/pi-tools-suite/src/async-subagents/agents/ui-qa.md`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/guides/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/backends/`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/native-terminal-host.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/native-terminal/bridge-client.mjs`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift`
- `external/pi-tools-suite/src/async-subagents/core/browser-qa.ts`
- `external/pi-tools-suite/src/async-subagents/core/spawn.ts`
- `external/pi-tools-suite/src/async-subagents/agents/ui-qa/browser/scripts/browser-qa-runner.mjs`
- `external/pi-tools-suite/test/async-subagents/core.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/browser-qa-runner.e2e.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-runner.test.ts`
- `external/pi-tools-suite/test/async-subagents/ui-qa-desktop.e2e.test.ts`
- `external/pi-tools-suite/test/async-subagents/selection-e2e.test.ts`

## Acceptance criteria

1. `ui-qa` resolves to the intended model/fallback and its inline Markdown
   workflow; explicit legacy `browser-qa` requests resolve to it, and its
   isolated child process can register the configured
   model provider.
2. Every child spawn contains `--no-skills` but no `--skill`. The QA child
   receives the thin common contract plus guide-routing workflow in its initial
   prompt, loads exactly one backend guide (plus the auth guide only when
   authentication is required) through `PI_UI_QA_RUNNER guide`, can invoke the
   unified runner probe/run, and can reach the credential-owning browser
   backend through `PI_BROWSER_QA_RUNNER`, from an unrelated project directory.
   Ordinary profiles are equally skill-free and do not receive QA-only
   environment paths.
3. Auth profile listing and all error output are redacted; model-authored input
   cannot execute code in the credential-bearing process.
4. Runner tests cover public execution without an auth file, explicit profile
   selection, all auth modes, fail-closed origins, path/mode hardening, private
   empty-template creation only on an explicit auth request, non-executable
   flows, and successful redacted evidence creation.
5. Native/TUI evidence, including bounded PTY replay, native-terminal real-
   window screenshots/video when requested and available, and exact-window
   desktop video when available, lives under the owning agent's `ui-qa/`
   workspace; browser flows/evidence remain under its browser-backend
   `browser-qa/` workspace. Deleting the run removes both while persistent auth
   config/state remains.
6. Runner tests prove that network activity and visible loading indicators are
   awaited, persistent loading fails the flow, visible actions retain a stable
   500 ms video interval, and context-wide click/drag video visualization is
   installed with bounded click pacing.
7. Completed test runs report clickable screenshot, video, and trace links
   whenever those artifacts exist.
8. Timeout tests identify the last browser stage, launcher progress remains
   available when full RPC logging is disabled, and process-tree tests prove a
   descendant is terminated without signalling unrelated processes.
9. TUI/native instructions require a real PTY/app driver, deterministic
   product-visible oracles, scoped cleanup, and a `BLOCKED` result when safe
   automation is unavailable rather than substituting source/unit tests.
   Pixel-sensitive TUI tasks select native-terminal presentation by capability
   need rather than app identity; the target still runs in one owned PTY while
   a private bridge mirrors its bytes into an owned real terminal window.
10. Suite tests/typecheck, host checks, and suite sync pass.
11. Unified runner tests cover deterministic backend/presentation selection,
    real PTY screen state and scoped cleanup, native-terminal bridge bootstrap
    isolation, unsafe launch/path rejection, timeout bounds, and platform
    blockers; the opt-in macOS E2E launches a real AppKit window, semantically
    activates its control, and retains accessibility, screenshot, and automatic
    exact-window video evidence.

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
