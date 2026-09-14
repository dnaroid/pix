# Browser detail: Playwright

Load this topic only when the browser router or `selection.guide` selected
`playwright`. Browser probe/run still goes through `PI_UI_QA_RUNNER`; do not
invoke the bundled browser runner directly except for the explicit auth
metadata/scaffold commands documented by the `auth` guide.

## Target and authentication

Use `target.browserDriver: "playwright"` when the route must be explicit.
Supported target fields are `url`/`baseUrl`, exact `allowedOrigins`, optional
trusted `profile`, and `browserDriver`. Do not combine Playwright with
`target.devtools`.

If the requested verification requires authentication, first load:

```sh
node "$PI_UI_QA_RUNNER" guide --backend browser --topic auth
```

Follow that guide for profile discovery/scaffolding. Never read, print, grep,
copy, or edit credential values from `.pi/qa_auth.jsonc`; the trusted runner
applies them internally. Put `authRejectedIf` directly after navigation or a
transition that may expose an expired session.

## Playwright flow surface

Supported actions:

- navigation/stability: `goto`, `reload`, `waitFor`, `waitForTimeout`;
- interaction: `click`, `doubleClick`, `hover`, `fill`, `press`, `check`,
  `uncheck`, `selectOption`, `wheel`, safe `evaluate`, `dragTo`, `uploadFiles`,
  `openPopup`, `download`;
- assertions: `assertVisible`, `assertHidden`, `assertEnabled`,
  `assertDisabled`, `assertChecked`, `assertUnchecked`, `assertText`,
  `assertTextContent`, `assertValue`, `assertAttribute`, `assertCount`,
  `assertURL`, `assertDOMMetric`;
- evidence/auth: `screenshot`, `authRejectedIf`.

Locators accept exactly one primary selector from `testId`, `role` (optional
`name`), `label`, `placeholder`, `text`, or `css`; add `exact: true` when useful.
Prefer stable product contracts in that order, with CSS as a last resort.
String assertions require exactly one of `equals` or `includes`.

`assertText` uses visible rendered text; use `assertTextContent` only when raw
DOM text is intentionally the oracle. `assertAttribute` is appropriate for
observable `aria-*`, `data-*`, `href`, and similar state. Assertions retry
within the bounded flow timeout.

## Viewport and deterministic environment

Optional top-level `viewport` accepts integer `width`/`height` from `320×240`
through `3840×2160`; default is `1280×720`. The same dimensions drive recorded
video.

Optional top-level `environment` supports:

- `locale`;
- `timezoneId`;
- `colorScheme`: `light`, `dark`, or `no-preference`;
- `reducedMotion`: `reduce` or `no-preference`.

Defaults are deterministic: `en-US`, `UTC`, `light`, and `reduce`. Set these
explicitly when locale/timezone/theme/motion affects the behavior.

## Interaction and causal expectations

Visible interactions wait for document readiness, causally-started requests in
a bounded readiness window, common visible busy markers, and a short stable
recording interval. Prefer an assertion immediately after an action over an
arbitrary sleep. `waitForTimeout` is bounded and should be exceptional.

Triggering interactions may arm race-free expectations before input:

- `expectResponse`: exact origin-relative `path`, uppercase `method`, and
  integer `status` 100..599;
- `expectDialog`: dialog `type`, a nested `message` matcher using exactly one of
  `equals`/`includes`, and boolean `accept`.

The runner does not publish response bodies/headers/query URLs or actual dialog
text in diagnostics.

`dragTo` requires a source `locator` and `dropTarget`, with optional bounded
relative source/drop positions. Do not emulate unsupported drag protocols with
raw JavaScript.

`uploadFiles` is memory-only: entries are `{name,mimeType,base64}`, up to 10
files, 5 MiB each and 10 MiB total. Filesystem paths/directories are unsupported;
an empty list clears the file input.

`download` atomically clicks and validates a nested safe filename matcher.
`maxBytes` defaults to 5 MiB and is capped at 25 MiB. Retain bytes only when
needed as evidence; retained downloads use runner-generated private names and
are scanned for configured authentication before publication.

## Frames, popups, scrolling, and safe evaluate

`openPopup` captures a same-origin popup under a safe name (maximum three).
Later steps can target `{ "type": "popup", "name": "..." }`. Same-origin
iframes use `{ "type": "frame", "locator": {...} }`, optionally inside a named
popup. Live origin is checked before scoped steps; cross-origin frames/popups
are rejected unless the provider contract explicitly supports them.

`wheel` accepts finite `deltaX`/`deltaY`, at least one non-zero. With a locator,
the runner hovers it before wheel input.

The `evaluate` action is not arbitrary JavaScript. Safe operations are:

- `scrollTo`: optional locator plus numeric `x`/`y` or `"max"`;
- `scrollBy`: optional locator plus numeric `deltaX`/`deltaY`;
- `metrics`: optional locator and safe name, returning bounded layout metrics.

Page/element metrics include scroll/client dimensions and positions. Use
`assertDOMMetric` with exactly one comparator (`equals`, `greaterThan`,
`greaterThanOrEqual`, `lessThan`, `lessThanOrEqual`) for pass/fail.

## Scenario design

Build the proof as setup -> smallest user action -> observable oracle. For a
fix verification, prefer one focused regression scenario rather than a tour.
Use semantic locators and state transitions; do not add timeouts merely to hide
races. A locator/setup error may justify fixing the flow, but an observed
product mismatch must remain a failure.

For responsive bugs, set the viewport and use DOM metrics when dimensions or
scroll state are part of the proof. For custom loaders not covered by the
runner's generic readiness model, explicitly wait/assert that loader state and
then assert loaded content.

## Evidence and cleanup

The trusted Playwright backend attempts final/failure screenshot, first-page
video, and sanitized post-auth trace; named `screenshot` steps should capture
only materially useful states. Popups can add separate videos. Pointer actions
may receive runner-owned visual annotations for chronology; those annotations
are evidence, never the oracle.

For authenticated form flows, password fields remain masked in video, but
visible login identifiers may appear; treat evidence as private. Tracing begins
only after login succeeds.

Each invocation owns an isolated context and private evidence directory and
closes resources in cleanup. Use separate runs for separate auth profiles. Do
not create a shared browser context, expose storage/cookies to the model, or
move backend evidence out of the agent-local workspace.
