# Browser backend guide

Load this guide only after the common UI QA contract selected the browser
backend. For a browser/web target, use the unified runner, which delegates to
the bundled trusted browser backend. That backend owns Playwright,
browser/context lifecycle, tracing, video, screenshots, origin isolation,
authentication, redaction, and cleanup. Do not invoke another browser CLI,
create shared/default browser sessions, or generate executable browser code.

The launcher also sets `PI_BROWSER_QA_RUNNER` to the absolute path of the
installed trusted browser backend. Never invoke it for probe/run; its only
direct uses (`profiles`, `profiles --require-auth`, `auth scaffold`) are
covered by the browser-auth guide
(`node "$PI_UI_QA_RUNNER" guide --backend browser --topic auth`). Its private
workspace remains `$PI_SUBAGENT_AGENT_DIR/browser-qa/`; that path is a
browser-backend implementation detail, not the role name.

Never read, print, grep, copy, or edit credential values from
`.pi/qa_auth.jsonc` yourself.

## Browser workflow

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

1. Use the launcher-provided `PI_UI_QA_RUNNER` for probe/run. If it is missing,
   report a launcher configuration blocker rather than selecting another runner.
2. Put the unified declarative flow in
   `$PI_SUBAGENT_AGENT_DIR/ui-qa/flows/`. The browser adapter writes its own
   private backend flow/evidence under `browser-qa/`; do not write there or
   override `PI_SUBAGENT_AGENT_DIR`.
3. Discover the requested actual target, expected behavior, and the smallest
   scenario that can prove it. Treat parent-supplied repository details as hints
   unless the user explicitly requested that exact harness. If the target cannot
   be reached or started, report the concrete blocker instead of switching to a
   mock target or substituting static checks for browser QA.
4. If the requested behavior actually requires authentication, load the auth
   guide with
   `node "$PI_UI_QA_RUNNER" guide --backend browser --topic auth` before profile
   discovery or scaffolding and follow it. Otherwise stay in public mode and do
   not inspect or create `.pi/qa_auth.jsonc`.
5. Inspect only enough target code to identify a supported launch path or stable
   locators, then write a unified declarative flow whose `target` contains
   `url`/`baseUrl`, optional `profile`, and optional exact `allowedOrigins`.
   Never put credentials or raw executable JavaScript in it. The `evaluate`
   action exposes only the safe operations documented below; it does not accept
   expressions or scripts.
6. Run browser QA through `node "$PI_UI_QA_RUNNER" run ...` as shown in the
   common contract. The target URL's exact origin becomes the fail-closed
   allowlist. Additional origins must be exact `http(s)` origins with no path,
   credentials, wildcard, or inferred sibling domain; undeclared origins remain
   blocked. Profile id, URL, and flow path are non-secret; never pass
   credentials as arguments or environment variables.
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

## Flow contract

The unified flow is `{ "version": 1, "target": { ... }, "steps": [...] }`, no
larger than 16 MiB, with at most 100 steps. The larger bound exists only for
bounded in-memory browser upload payloads. The adapter passes the browser
`steps`, `viewport`, `environment`, and `timeoutMs` to the trusted backend.
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

Example flow:

```jsonc
{
  "version": 1,
  "target": {
    "url": "https://staging.example.test/settings",
    "profile": "staging-admin",
    "allowedOrigins": ["https://staging.example.test"]
  },
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
all owned browser resources on success and failure. The unified source flow
remains under `$PI_SUBAGENT_AGENT_DIR/ui-qa/`; adapter flows, screenshots, video,
sanitized traces, retained downloads, and browser result manifests remain under
`$PI_SUBAGENT_AGENT_DIR/browser-qa/` so normal sub-agent shutdown or cleanup
deletes them with the run directory. For form auth, recording starts on the login
page and includes field filling and submission; password inputs remain masked,
but the private video may show visible login identifiers. Tracing starts only
after login succeeds so credentials are not captured in the trace.

## Detailed scenario-design guidance

### Build the proof before the steps

Write down three things first:

1. **Setup:** the page and state needed to expose the behavior.
2. **Action:** the smallest user interaction that exercises it.
3. **Oracle:** the observable state that proves success or reproduces failure.

Good oracles are product-visible and specific: an exact URL, a stable status
message, a field value, item count, enabled/disabled state, or checked state.
Avoid treating "the click did not throw" or "the screenshot looks plausible" as
proof.

When verifying a fix, prefer a focused regression flow over a broad tour of the
application. If multiple independent states matter, assert each one explicitly.

For explicit exploratory/manual QA, keep exploration bounded rather than turning
it into an open-ended crawl. Run at most three minimal rounds. Each round should
start from one concrete hypothesis, produce a deterministic observation plus a
meaningful screenshot, and use that evidence to decide whether another round is
justified. Verification tasks remain one browser run per profile.

### Choose resilient locators

Prefer locators that match how users and accessibility APIs identify controls:

1. `testId` when the product exposes a stable test contract.
2. `role` with accessible `name` for buttons, links, headings, dialogs, and
   similar semantic elements.
3. `label` for form controls.
4. `placeholder` or visible `text` when they are stable product copy.
5. `css` only when no semantic contract exists.

Use `exact: true` when duplicate or substring matches are possible. Avoid CSS
that encodes DOM depth, generated classes, styling details, or element order.
If a locator is ambiguous, inspect nearby source or rendered copy and choose a
more specific product contract rather than adding arbitrary delays.

### Wait for state, not time

Runner interactions inherit Playwright auto-waiting. Usually an action followed
by an assertion is enough. Use `waitFor` only when the next operation depends on
a distinct attached/detached/visible/hidden transition.

After navigation and visible interactions, the runner also waits for DOM
readiness, tracks requests causally started by that action through a bounded
readiness window, waits for common visible
`aria-busy`/progress/loading/spinner/skeleton markers, and keeps a 500 ms stable
interval. EventSource/WebSocket traffic is ignored, and a long poll is not
allowed to pin the entire flow timeout. A visible busy indicator may still hold
readiness until `timeoutMs`. This is a safe baseline, not an application-specific
oracle: explicitly wait for a custom loader to become hidden and assert the
loaded content when the application uses different readiness semantics.

`waitForTimeout` is bounded to five seconds and should be exceptional—for a
known animation, debounce, or externally scheduled transition with no
observable intermediate state. Sleeping longer hides races instead of proving
behavior. If a normal operation legitimately needs more time, adjust the flow's
`timeoutMs` rather than inserting repeated sleeps.

All assertion actions retry until that timeout. This makes an action followed
directly by `assertText`, `assertVisible`, `assertURL`, or another assertion
safe for asynchronously rendered outcomes. `assertText` requires the locator to
be visible and matches rendered `innerText`; use `assertTextContent` only when
hidden/raw DOM text is deliberately part of the oracle. Use `assertAttribute`
for observable state such as `aria-expanded`, `aria-invalid`, or `data-state`
instead of reading DOM state through executable JavaScript.

### Responsive and scrolling scenarios

Set the flow's top-level `viewport` whenever the bug depends on a breakpoint or
available height. Assert `viewportWidth` or `viewportHeight` with
`assertDOMMetric` when the dimensions themselves are part of the proof; the
runner also includes the applied viewport in its result.

Use `wheel` to reproduce real pointer-wheel input. Add a locator when the wheel
must target a nested scrolling container—the runner hovers it before sending
the input. Because browser scrolling may be scheduled after the wheel event,
wait only for a short known settling interval when a direct metric assertion is
otherwise racy.

Use safe `evaluate` `scrollTo`/`scrollBy` operations for deterministic setup or
to distinguish input handling from layout behavior. Use the `metrics` operation
to retain a named page/element snapshot in result `observations`, and use
`assertDOMMetric` for pass/fail. Raw JavaScript expressions are intentionally
excluded: flows remain declarative and cannot inspect authentication storage or
execute arbitrary same-origin requests.

### Deterministic browser environment

Set top-level `environment` when locale, timezone, color scheme, or motion
preferences can change the behavior. The runner otherwise uses stable defaults
(`en-US`, `UTC`, `light`, `reduce`) instead of inheriting host settings. Prefer
asserting product-visible copy or state derived from those settings; do not use
screenshot pixels as the only oracle.

### Causal network and dialog expectations

Put `expectResponse` or `expectDialog` on the interaction that causes the event.
The runner arms both listeners before the interaction, avoiding the race in a
separate "click, then wait" sequence. Response expectations deliberately match
only an exact allowlisted-origin pathname, HTTP method, and status. This proves
that a matching request started and received a response within the action
window without retaining its URL query, headers, or body.

Dialog expectations match a fixed dialog type and exact/included message, then
accept or dismiss it declaratively. A mismatch is dismissed before the step
fails so the page cannot freeze. Actual event metadata is never included in
failure diagnostics. Do not place secrets in expected messages or response
paths even though the runner keeps diagnostics generic.

### Drag, upload, and download scenarios

Use `dragTo` for native DOM drag/drop and assert the resulting product state.
Optional source/drop positions are relative bounded coordinates. Canvas-only,
OS-native, or custom synthetic-event drag protocols remain unsupported; do not
work around that with executable JavaScript.

Uploads are memory-only base64 payloads declared in the flow. This intentionally
prevents a flow from selecting arbitrary project files, credential config, or
directories. Keep fixtures minimal and non-secret. An empty file list clears a
file input.

Use the atomic `download` action rather than clicking a download link directly.
Always match the suggested filename and choose a tight `maxBytes`. Retain a
download only when its contents are needed as evidence; otherwise the runner
deletes it after validation. Retained downloads use generated private names,
not server-provided paths, and are scanned for configured authentication before
publication. `maxBytes` bounds the runner's private evidence copy and triggers
cancellation while it grows, but it is not a network-bandwidth guarantee: the
browser can receive temporary bytes before cancellation.

### Same-origin frames and popups

Use a scoped `target` for iframe or named popup interactions. The runner checks
the live frame origin before every scoped step and checks a popup after it loads;
both must remain in `allowedOrigins`. This supports embedded application UI and
same-origin auxiliary windows without opening a route around the network guard.
Cross-origin login, payment, and third-party widgets remain intentionally out of
scope. Each popup adds a separate private video artifact, so open only the
windows needed for the proof.

### Authentication transitions

Add `authRejectedIf` directly after initial navigation and after transitions
that can redirect to login or display an expired-session marker. This converts
stale credentials into an explicit update request instead of misreporting a
product regression.

Do not encode credentials, tokens, storage values, or login form secrets in the
flow. The trusted runner applies the selected profile internally. For form auth,
video starts on the login page and includes field filling and submission; password
inputs remain masked, but visible identifiers can appear, so treat the video as
sensitive private evidence. Tracing starts only after login succeeds and is
sanitized before retention.

### Evidence strategy

The runner always attempts a final or failure screenshot, records video from the
first page, and creates a sanitized post-auth trace. Add named `screenshot`
steps only at states that materially help explain the result—for example before
and after a destructive interaction, or when a transient success message is
the oracle.

Use evidence by purpose:

- **Screenshot:** quick review of one meaningful visual state.
- **Video:** chronological confirmation of the complete user flow.
- **Trace:** action/DOM timing diagnosis for a failed or flaky interaction.

Videos automatically show a transient cursor and yellow pulse for clicks and
double-clicks. After a native `dragTo` gesture completes, its resolved
source-to-target route is replayed over 450 ms with a large orange cursor and
progressively drawn high-contrast trail, followed by a green drop marker. These
annotations are
runner-owned, pointer-transparent, and accessibility-hidden; they cover the main
page, same-origin frames, declared popups, and form-auth submission. Their
bounded animations finish within the normal post-action stable interval, so
they explain the chronology without becoming screenshot or assertion oracles.

Assertions determine pass/fail; evidence explains it. Preserve and link every
artifact group returned on both passed and failed runs.

For visual QA, do not stop at artifact generation. Open at least one meaningful
PNG with the model's image-capable `read` path and inspect layout, clipping,
overlap, state styling, and other visual defects relevant to the scenario. If
the active model cannot read images, explicitly report visual inspection as
unavailable rather than treating deterministic assertions as a visual pass.

### Diagnose failures without weakening the test

Classify the first failing step:

- wrong target/setup or service unavailable;
- authentication rejected or expired;
- locator no longer matches the product contract;
- expected state never appeared;
- actual product behavior contradicts the expectation.

Fix the flow only when its setup or locator is wrong. Do not replace a precise
assertion with a vague one, increase timeouts reflexively, or remove the failing
step to manufacture a pass. Keep the failure artifacts and state the expected
versus observed behavior.

### Cleanup and isolation

Each runner invocation owns one isolated context and evidence directory and
closes its browser resources in a `finally` path. Do not create parallel shared
or default sessions outside the runner. Test multiple auth profiles with
separate invocations so cookies, storage, traces, and evidence cannot mix.

Keep the unified declarative flow inside `$PI_SUBAGENT_AGENT_DIR/ui-qa/flows/`
and every browser-generated screenshot, video, trace, and result manifest inside
`$PI_SUBAGENT_AGENT_DIR/browser-qa/`. The launcher owns both paths and the
runners validate them before opening a browser. Do not override the environment
path or copy evidence into shared `.pi/qa-runs`/`.pi/qa-flows` directories: the
agent-local workspaces are intentionally removed by the normal sub-agent
shutdown and cleanup lifecycle. Authentication config remains a separate
persistent input under project `.pi/`.
