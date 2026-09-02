# Designing deterministic browser QA flows

Use this reference with the bundled declarative runner. It intentionally does
not describe a separate browser CLI or executable Playwright scripts.

## Build the proof before the steps

Write down three things first:

1. **Setup:** the page and state needed to expose the behavior.
2. **Action:** the smallest user interaction that exercises it.
3. **Oracle:** the observable state that proves success or reproduces failure.

Good oracles are product-visible and specific: an exact URL, a stable status
message, a field value, item count, enabled/disabled state, or checked state.
Avoid treating “the click did not throw” or “the screenshot looks plausible” as
proof.

When verifying a fix, prefer a focused regression flow over a broad tour of the
application. If multiple independent states matter, assert each one explicitly.

For explicit exploratory/manual QA, keep exploration bounded rather than turning
it into an open-ended crawl. Run at most three minimal rounds. Each round should
start from one concrete hypothesis, produce a deterministic observation plus a
meaningful screenshot, and use that evidence to decide whether another round is
justified. Verification tasks remain one browser run per profile.

## Choose resilient locators

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

## Wait for state, not time

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
hidden/raw DOM text is deliberately part of the oracle. Use `assertAttribute` for
observable state such as `aria-expanded`, `aria-invalid`, or `data-state`
instead of reading DOM state through executable JavaScript.

## Responsive and scrolling scenarios

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

## Deterministic browser environment

Set top-level `environment` when locale, timezone, color scheme, or motion
preferences can change the behavior. The runner otherwise uses stable defaults
(`en-US`, `UTC`, `light`, `reduce`) instead of inheriting host settings. Prefer
asserting product-visible copy or state derived from those settings; do not use
screenshot pixels as the only oracle.

## Causal network and dialog expectations

Put `expectResponse` or `expectDialog` on the interaction that causes the event.
The runner arms both listeners before the interaction, avoiding the race in a
separate “click, then wait” sequence. Response expectations deliberately match
only an exact allowlisted-origin pathname, HTTP method, and status. This proves
that a matching request started and received a response within the action
window without retaining its URL query, headers, or body.

Dialog expectations match a fixed dialog type and exact/included message, then
accept or dismiss it declaratively. A mismatch is dismissed before the step
fails so the page cannot freeze. Actual event metadata is never included in
failure diagnostics. Do not place secrets in expected messages or response
paths even though the runner keeps diagnostics generic.

## Drag, upload, and download scenarios

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

## Same-origin frames and popups

Use a scoped `target` for iframe or named popup interactions. The runner checks
the live frame origin before every scoped step and checks a popup after it loads;
both must remain in `allowedOrigins`. This supports embedded application UI and
same-origin auxiliary windows without opening a route around the network guard.
Cross-origin login, payment, and third-party widgets remain intentionally out of
scope. Each popup adds a separate private video artifact, so open only the
windows needed for the proof.

## Authentication transitions

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

## Evidence strategy

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

## Diagnose failures without weakening the test

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

## Cleanup and isolation

Each runner invocation owns one isolated context and evidence directory and
closes its browser resources in a `finally` path. Do not create parallel shared
or default sessions outside the runner. Test multiple auth profiles with
separate invocations so cookies, storage, traces, and evidence cannot mix.

Keep the declarative flow and every generated screenshot, video, trace, and
result manifest inside `$PI_SUBAGENT_AGENT_DIR/browser-qa/`. The launcher owns
that path and the runner validates it before opening a browser. Do not override
the environment path or copy evidence into shared `.pi/qa-runs`/`.pi/qa-flows`
directories: the agent-local workspace is intentionally removed by the normal
sub-agent shutdown and cleanup lifecycle. Authentication config remains a
separate persistent input under project `.pi/`.
