---
name: browser-qa-private
description: Private self-contained workflow for deterministic browser bug reproduction and fix verification with redacted project auth and Playwright evidence.
---

# Browser QA

Use this skill's bundled runner as the only browser interface. It already owns
Playwright, browser/context lifecycle, tracing, video, screenshots, origin
isolation, authentication, redaction, and cleanup. Do not invoke another browser
CLI, create shared/default browser sessions, or generate executable browser code.

Never read, print, grep, copy, or edit credential values from
`.pi/qa_auth.jsonc` yourself.

## Workflow

Treat target discovery as a 30-second preflight and invoke the runner within 45
seconds of starting. Use at most one runner invocation unless the task explicitly
requests multiple auth profiles. If you cannot identify a reachable target and
a supported deterministic assertion inside that preflight, return a structured
`BLOCKED` result immediately. Do not consume the launcher budget on further
source reading, server polling, capability probing, or retries.

1. Resolve `scripts/browser-qa-runner.mjs` relative to this skill.
2. Use the launcher-provided `$PI_SUBAGENT_AGENT_DIR/browser-qa/` workspace.
   The launcher creates its private `flows/` directory and the runner rejects
   flows or evidence destinations outside this owning sub-agent directory. Do
   not override `PI_SUBAGENT_AGENT_DIR` or copy evidence to shared project paths.
3. Discover the requested target, expected behavior, and the smallest scenario
   that can prove it. If the target cannot be reached or started, report the
   concrete blocker instead of substituting static checks for browser QA.
4. If the requested behavior requires authentication, run
   `node <runner> profiles`. A missing auth config is valid and returns an empty
   list without creating `.pi/qa_auth.jsonc`. Otherwise skip profile discovery
   and use public mode. Choose an auth profile only when the task names its id,
   safe profile traits make the choice unambiguous, or a public run proves that
   the requested page requires login.
5. Inspect the target code and write a declarative JSONC flow under
   `$PI_SUBAGENT_AGENT_DIR/browser-qa/flows/`. Never put credentials or
   executable JavaScript in it.
6. Run public QA with
   `node <runner> run --base-url <url> --flow <flow.jsonc>`. The URL's exact
   origin becomes the fail-closed allowlist. Only for authenticated QA, add
   `--profile <id>`; the selected profile then owns the URL and allowlist.
   Profile id, URL, and flow path are non-secret; never pass credentials as
   arguments or environment variables.
7. Report deterministic assertions and every artifact returned by the runner.
   For each screenshot, video, or trace, emit a separate clickable Markdown
   link using its `uri` and also show its absolute `path`. Do this for failed
   runs too whenever `artifacts` is present; never report only `evidenceDir`.
   Visual inspection supplements assertions; it does not replace them.

## Scenario design

- Define the expected postcondition before writing interactions. A successful
  click or navigation is not proof; assert the resulting URL, text, value,
  count, visibility, enabled state, or checked state.
- Keep the flow minimal and reproducible. Capture setup, the action under test,
  and at least one observable outcome; add a screenshot at the state that best
  explains the result.
- Prefer stable user-facing locators in this order: `testId`; semantic `role`
  plus accessible `name`; `label`; `placeholder`; visible `text`; CSS only as a
  last resort. Use `exact: true` when similar elements could make a match
  ambiguous.
- Let locator actions auto-wait. Use `waitFor` for an explicit UI state and use
  `waitForTimeout` only for a short, unavoidable animation/debounce—not as a
  substitute for an assertion. Set flow `timeoutMs` only as high as the target
  legitimately needs.
- Place `authRejectedIf` immediately after navigation or any transition that
  may reveal expired authentication.
- Never weaken an assertion merely to make a failing run pass. If the observed
  product behavior differs from the expectation, preserve the failure evidence
  and report the mismatch.

Read `references/qa-design.md` when designing a non-trivial flow, diagnosing an
ambiguous failure, or deciding what evidence proves the result.

## Flow contract

The flow is `{ "steps": [...] }` with at most 100 steps. Supported actions:

- navigation: `goto`, `reload`, `waitFor`, `waitForTimeout`
- interaction: `click`, `doubleClick`, `hover`, `fill`, `press`, `check`,
  `uncheck`, `selectOption`
- assertions: `assertVisible`, `assertHidden`, `assertEnabled`,
  `assertDisabled`, `assertChecked`, `assertUnchecked`, `assertText`,
  `assertValue`, `assertCount`, `assertURL`
- evidence/auth: `screenshot`, `authRejectedIf`

Locators accept one of `testId`, `role` (plus optional `name`), `label`,
`placeholder`, `text`, or `css`; add `exact: true` where useful. String
assertions require exactly one of `equals` or `includes`.

```jsonc
{
  "steps": [
    { "action": "goto", "path": "/settings" },
    { "action": "authRejectedIf", "urlIncludes": "/login" },
    {
      "action": "assertVisible",
      "locator": { "role": "heading", "name": "Settings", "exact": true }
    },
    { "action": "click", "locator": { "testId": "save-settings" } },
    { "action": "assertText", "locator": { "testId": "toast" }, "includes": "Saved" },
    { "action": "screenshot", "name": "settings-saved" }
  ]
}
```

For multiple profiles, invoke the runner separately. Every invocation gets an
isolated browser context and exclusive evidence directory; the runner closes
all owned browser resources on success and failure. Flows, screenshots, video,
sanitized traces, and runner result manifests remain under
`$PI_SUBAGENT_AGENT_DIR/browser-qa/` so normal sub-agent shutdown or cleanup
deletes them with the run directory. For form auth, recording starts on the login
page and includes field filling and submission; password inputs remain masked,
but the private video may show visible login identifiers. Tracing starts only
after login succeeds so credentials are not captured in the trace.

## Credentials and blocked runs

Do not request credentials merely because `.pi/qa_auth.jsonc` is absent. If the
task explicitly requires authenticated behavior, or a public run reaches the
flow's `authRejectedIf` check, and `profiles` returned no usable profile, run
`node <runner> profiles --require-auth`. Only this explicit authenticated path
may create the private empty template.

If that command or an authenticated run returns `QA_AUTH_UPDATE_REQUIRED`, stop
and explicitly report that authenticated browser QA requires credentials or an
auth-config update. Ask the user to fill the reported file and rerun QA. If
`templateCreated` is true, say that a private empty template was created at that
path. Relay only the runner's profile, file, reason, action, and template-created
state; never read the generated file or attempt to recover by exposing or
replaying credentials.

For any other blocked run, report the runner status and redacted reason. Do not
claim that browser QA passed based on source inspection, unit tests, or a build.

After any runner invocation that actually performed browser testing, include
all non-empty `artifacts.screenshots`, `artifacts.videos`, and
`artifacts.traces` groups in the final response. These links are mandatory so
the user can open the evidence directly.

See `references/qa-auth.example.jsonc`, `references/qa-flow.example.jsonc`, and
`references/qa-design.md`.
