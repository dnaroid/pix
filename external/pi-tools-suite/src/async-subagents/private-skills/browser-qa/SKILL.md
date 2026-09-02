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

Treat the launch brief as a user-visible acceptance contract, not an execution
plan. It should identify the actual target URL/app when known, the user flow,
the expected observable result, and required evidence. Missing details are
preflight unknowns, not permission to invent a different target. Never create,
serve, or switch to a mock/synthetic page, test fixture, or built-in harness
unless the user explicitly requested that exact target. Source inspection and
repository tests may support discovery, but they never substitute for testing
the requested target in the browser.

## Workflow

Treat target discovery as a 30-second preflight and begin browser execution within
45 seconds of starting. For a verification task, use at most one actual `run`
browser execution per profile. Metadata/preparation commands such as `profiles`
and form-auth `scaffold` do not count as browser verification runs. For an
explicit exploratory/manual-QA task, use at most three `run` rounds, give each a
unique `--run-id`, bound each with `--runner-timeout-ms 60000`, and let each round
test one concrete hypothesis learned from the prior evidence. Stop earlier once
the requested behavior is explained or no new supported hypothesis remains. If
you cannot identify a reachable target and a supported deterministic assertion
inside the preflight, return a structured `BLOCKED` result immediately. Do not
consume the launcher budget on open-ended source reading, server polling,
capability probing, or retries.

1. Resolve `scripts/browser-qa-runner.mjs` relative to this skill.
2. Use the launcher-provided `$PI_SUBAGENT_AGENT_DIR/browser-qa/` workspace.
   The launcher creates its private `flows/` directory and the runner rejects
   flows or evidence destinations outside this owning sub-agent directory. Do
   not override `PI_SUBAGENT_AGENT_DIR` or copy evidence to shared project paths.
3. Discover the requested actual target, expected behavior, and the smallest
   scenario that can prove it. Treat parent-supplied repository details as hints
   unless the user explicitly requested that exact harness. If the target cannot
   be reached or started, report the concrete blocker instead of switching to a
   mock target or substituting static checks for browser QA.
4. If the requested behavior requires authentication, run
   `node <runner> profiles`. A missing auth config is valid and returns an empty
   list without creating `.pi/qa_auth.jsonc`. Otherwise skip profile discovery
   and use public mode. Choose an auth profile only when the task names its id,
   safe profile traits make the choice unambiguous, or a public run proves that
   the requested page requires login. If form authentication is required but
   there is no usable profile, follow **Form-auth scaffolding** below instead of
   asking the user to discover selectors.
5. Inspect only enough target code to identify a supported launch path or stable
   locators, then write a declarative JSONC flow under
   `$PI_SUBAGENT_AGENT_DIR/browser-qa/flows/`. Never put credentials or raw
   executable JavaScript in it. The `evaluate` action exposes only the safe
   operations documented below; it does not accept expressions or scripts.
6. Run public QA with
   `node <runner> run --base-url <url> --flow <flow.jsonc>`. The URL's exact
   origin becomes the fail-closed allowlist. When the real app requires known
   API/CDN origins, add repeatable `--allow-origin <exact-origin>` flags. Each
   value must be an exact `http(s)` origin with no path, credentials, wildcard,
   or inferred sibling domain; undeclared origins remain blocked. Only for
   authenticated QA, add `--profile <id>`; the selected profile then owns the
   URL and allowlist.
   Profile id, URL, and flow path are non-secret; never pass credentials as
   arguments or environment variables.
7. Report deterministic assertions and every artifact returned by the runner.
   For each screenshot, video, trace, or retained download, emit a separate
   clickable Markdown link using its `uri` and also show its absolute `path`.
   Do this for failed runs too whenever `artifacts` is present; never report only
   `evidenceDir`.
   When screenshots are present, inspect at least one representative meaningful
   PNG directly with the `read` tool on its absolute path before claiming visual
   QA. Inspect additional screenshots when they represent materially different
   states or popups. Record `visualInspection: inspected` plus the inspected
   paths and concrete findings. If image reading is unavailable in the active
   model, report `visualInspection: unavailable` and do not claim a visual pass;
   deterministic assertions may still be reported separately. Visual inspection
   supplements assertions; it does not replace them.

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
- Let locator actions auto-wait. Assertions retry until the flow timeout, so
  prefer them over a preceding sleep. Use `waitFor` for an explicit setup state
  and `waitForTimeout` only for short input settling or an unavoidable
  animation/debounce. Set flow `timeoutMs` only as high as the target
  legitimately needs.
- The runner waits after every visible interaction until the document is ready,
  observes requests started by the interaction for a bounded readiness window,
  and waits for common visible busy
  markers (including `aria-busy`, progress bars, loading/spinner/skeleton test
  ids and classes) to disappear. EventSource/WebSocket traffic is excluded and
  a long-poll/background request cannot pin readiness for the full flow timeout;
  visible busy UI can. It then keeps the stable state on video for 500 ms. A
  busy page that does not settle within `timeoutMs` fails instead of continuing
  against a skeleton. For an app-specific loader not covered by
  those conventions, add an explicit `waitFor`/`assertHidden` for that loader
  and assert the loaded content before interacting with it.
- Recorded pointer actions are annotated automatically: clicks and double-clicks
  show a cursor and pulse. After a native `dragTo` completes, the runner visibly
  replays the resolved source-to-target route for 450 ms with a large orange
  cursor and progressively drawn high-contrast trail, then shows a green drop
  marker. The
  isolated annotation layer applies to the main page, same-origin frames,
  declared popups, and form-auth submission; it is accessibility-hidden, ignores
  pointer input, and clears before the runner's post-action stable interval
  completes.
- Place `authRejectedIf` immediately after navigation or any transition that
  may reveal expired authentication. It must declare `urlIncludes` or a locator;
  an empty rejection check is invalid.
- Never weaken an assertion merely to make a failing run pass. If the observed
  product behavior differs from the expectation, preserve the failure evidence
  and report the mismatch.

Read `references/qa-design.md` when designing a non-trivial flow, diagnosing an
ambiguous failure, or deciding what evidence proves the result.

## Flow contract

The flow is `{ "steps": [...] }`, no larger than 16 MiB, with at most 100
steps. The larger bound exists only for bounded in-memory upload payloads.
Supported actions:

- navigation: `goto`, `reload`, `waitFor`, `waitForTimeout`
- interaction: `click`, `doubleClick`, `hover`, `fill`, `press`, `check`,
  `uncheck`, `selectOption`, `wheel`, `evaluate`, `dragTo`, `uploadFiles`,
  `openPopup`, `download`
- assertions: `assertVisible`, `assertHidden`, `assertEnabled`,
  `assertDisabled`, `assertChecked`, `assertUnchecked`, `assertText`, `assertTextContent`,
  `assertValue`, `assertAttribute`, `assertCount`, `assertURL`,
  `assertDOMMetric`
- evidence/auth: `screenshot`, `authRejectedIf`

Locators accept one of `testId`, `role` (plus optional `name`), `label`,
`placeholder`, `text`, or `css`; add `exact: true` where useful. String
assertions require exactly one of `equals` or `includes`.
`assertText` matches visible, user-facing `innerText` and therefore fails for a
hidden locator. Use `assertTextContent` only when raw DOM text, including hidden
content, is intentionally the oracle.
`assertAttribute` additionally requires a bounded `attribute` name and is
useful for `aria-*`, `data-*`, `href`, and similar observable state. All
assertions retry until `timeoutMs` and report generic failures without exposing
the actual text, value, or attribute content.

Set an optional top-level `viewport` with integer `width` and `height` from
`320×240` through `3840×2160`; the default is `1280×720`. The same dimensions
are used for the browser viewport and recorded video.

The top-level `environment` may set `locale`, `timezoneId`, `colorScheme`, and
`reducedMotion`. Defaults are deterministic: `en-US`, `UTC`, `light`, and
`reduce`. Color scheme accepts `light`, `dark`, or `no-preference`; reduced
motion accepts `reduce` or `no-preference`. The resolved environment is returned
in the result alongside the viewport.

Navigation and visible interaction actions automatically wait for page
readiness and a 500 ms stable recording interval. This applies to the main
page, same-origin frames and declared popups, and to the trusted form-auth
sequence. An explicit `waitForTimeout` is not extended by another automatic
delay. Click-like actions use a short bounded press duration so their automatic
video pulse remains visible even when the click immediately navigates.

Triggering interactions (`click`, `doubleClick`, `press`, `check`, `uncheck`,
and `selectOption`) may declare race-free expectations that are armed before
the interaction:

- `expectResponse`: exact origin-relative `path` (without query/fragment),
  uppercase `method`, and integer `status` from 100 through 599;
- `expectDialog`: `type` (`alert`, `beforeunload`, `confirm`, or `prompt`), a
  nested `message` matcher with exactly one of `equals`/`includes`, and boolean
  `accept`.

The runner never records response bodies, headers, URLs, actual dialog text, or
prompt defaults in observations or failure reasons. A mismatching dialog is
dismissed so it cannot deadlock the browser.

`dragTo` requires a source `locator` and `dropTarget`, with optional bounded
`sourcePosition` and `dropPosition` `{ x, y }`. `uploadFiles` accepts only
in-memory entries `{ name, mimeType, base64 }`; up to 10 files, 5 MiB each and
10 MiB total. An empty array clears the input. Filesystem paths and directories
are not supported.

`download` atomically clicks its locator and requires a nested `filename`
matcher. `maxBytes` defaults to 5 MiB and is capped at 25 MiB. Downloads are
deleted after validation unless `retain: true` and a safe `name` are supplied;
retained bytes appear in `artifacts.downloads` under a runner-generated `.bin`
name. The runner cancels while its private copy grows past `maxBytes`, but this
is an evidence-retention bound rather than a network-bandwidth guarantee because
the browser may already hold temporary bytes. Retained bytes are scanned for
configured authentication before publication. The actual server filename is
never placed in diagnostics.

`openPopup` atomically clicks a locator, captures a same-origin popup, and stores
it under a safe `name` (maximum three). Target later actions with
`{ "target": { "type": "popup", "name": "..." } }`. Target same-origin
iframes with `{ "target": { "type": "frame", "locator": { ... } } }`; add
`page` with a popup name for a frame inside that popup. Frame origin is checked
from its live document before every scoped step. Cross-origin popups/frames are
rejected. Popup recordings are returned as separate video artifacts.

`wheel` accepts finite `deltaX`/`deltaY` values and requires at least one
non-zero delta. With a locator, the runner hovers that element before sending
the wheel input. Safe `evaluate` operations are:

- `scrollTo`: optional locator plus numeric `x`/`y` or the string `"max"`;
- `scrollBy`: optional locator plus numeric `deltaX`/`deltaY`;
- `metrics`: optional locator plus an optional safe `name`; values are returned
  in the runner's `observations` array.

Element metrics are `scrollLeft`, `scrollTop`, `scrollWidth`, `scrollHeight`,
`clientWidth`, `clientHeight`, `x`, `y`, `width`, and `height`. Page metrics are
`scrollX`, `scrollY`, `scrollWidth`, `scrollHeight`, `clientWidth`,
`clientHeight`, `viewportWidth`, and `viewportHeight`. Use `assertDOMMetric`
with a `metric` and exactly one of `equals`, `greaterThan`,
`greaterThanOrEqual`, `lessThan`, or `lessThanOrEqual` for a deterministic
oracle. Raw JavaScript remains intentionally unsupported.

```jsonc
{
  "viewport": { "width": 844, "height": 847 },
  "environment": {
    "locale": "en-GB",
    "timezoneId": "Europe/London",
    "colorScheme": "dark"
  },
  "steps": [
    { "action": "goto", "path": "/settings" },
    { "action": "authRejectedIf", "urlIncludes": "/login" },
    {
      "action": "assertVisible",
      "locator": { "role": "heading", "name": "Settings", "exact": true }
    },
    {
      "action": "wheel",
      "locator": { "css": ".settings-panel" },
      "deltaY": 500
    },
    {
      "action": "assertDOMMetric",
      "locator": { "css": ".settings-panel" },
      "metric": "scrollTop",
      "greaterThan": 0
    },
    {
      "action": "click",
      "locator": { "testId": "save-settings" },
      "expectResponse": {
        "path": "/api/settings",
        "method": "PUT",
        "status": 200
      }
    },
    {
      "action": "assertText",
      "locator": { "testId": "toast" },
      "includes": "Saved"
    },
    { "action": "screenshot", "name": "settings-saved" }
  ]
}
```

For multiple profiles, invoke the runner separately. Every invocation gets an
isolated browser context and exclusive evidence directory; the runner closes
all owned browser resources on success and failure. Flows, screenshots, video,
sanitized traces, retained downloads, and runner result manifests remain under
`$PI_SUBAGENT_AGENT_DIR/browser-qa/` so normal sub-agent shutdown or cleanup
deletes them with the run directory. For form auth, recording starts on the login
page and includes field filling and submission; password inputs remain masked,
but the private video may show visible login identifiers. Tracing starts only
after login succeeds so credentials are not captured in the trace.

## Credentials and blocked runs

### Form-auth scaffolding

When a public HTTPS login page (or loopback HTTP page for local development) is
known and there is no usable profile, invoke the trusted runner once:

```sh
node <runner> auth scaffold \
  --profile <safe-id> \
  --login-url <public-login-url>
```

The runner discovers the login form and privately writes a target-specific
`.pi/qa_auth.jsonc` containing `__PI_QA_SECRET_n__` values. It may create the
file or replace only the runner's own empty generated template; it refuses to
overwrite invalid or non-empty auth configuration. Never inspect the result.
Relay `QA_AUTH_SCAFFOLD_CREATED`, the reported file, profile, placeholder count,
and action, then ask the user to replace only those placeholder values. Browser
QA must resume in a new run after the user confirms that edit.

By default, login succeeds when the discovered form becomes hidden. A form-less
page therefore requires an explicit deterministic signal using either
`--success-url <glob>` or `--success-selector <selector>` with optional
`--success-state attached|detached|visible|hidden`. Use `--base-url <url>` only
to override the profile's same-origin application root. These are public
metadata; never put credential values in command arguments or environment
variables.

Do not scaffold cookie, bearer, storage, storage-state, MFA, CAPTCHA, or
federated login. For those modes, use the generic empty-template flow below and
ask the user to configure the profile themselves.

Do not request credentials merely because `.pi/qa_auth.jsonc` is absent. If the
task explicitly requires authenticated behavior, or a public run reaches the
flow's `authRejectedIf` check, and `profiles` returned no usable profile, run
form-auth scaffolding when supported. Otherwise run
`node <runner> profiles --require-auth`. Only these explicit authenticated paths
may create the private auth file.

If that command or an authenticated run returns `QA_AUTH_UPDATE_REQUIRED`, stop
and explicitly report that authenticated browser QA requires credentials or an
auth-config update. Ask the user to fill the reported file and rerun QA. If
`templateCreated` is true, say that a private empty template was created at that
path. Relay only the runner's profile, file, reason, action, and template-created
state; never read the generated file or attempt to recover by exposing or
replaying credentials. If the action is `fill_credentials`, also relay the
placeholder count and tell the user to replace only the generated placeholder
values.

For any other blocked run, report the runner status and redacted reason. Do not
claim that browser QA passed based on source inspection, unit tests, or a build.

After any runner invocation that actually performed browser testing, include
all non-empty `artifacts.screenshots`, `artifacts.videos`, and
`artifacts.traces`, and `artifacts.downloads` groups in the final response.
These links are mandatory so the user can open the evidence directly.
Also include `visualInspection` with `inspected` or `unavailable`; never infer a
visual pass from a successful runner status alone.

See `references/qa-auth.example.jsonc`, `references/qa-flow.example.jsonc`,
`references/qa-design.md`, and `references/auth-scaffold-spec.md`.
