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

`waitForTimeout` is bounded to five seconds and should be exceptional—for a
known animation, debounce, or externally scheduled transition with no
observable intermediate state. Sleeping longer hides races instead of proving
behavior. If a normal operation legitimately needs more time, adjust the flow's
`timeoutMs` rather than inserting repeated sleeps.

## Authentication transitions

Add `authRejectedIf` directly after initial navigation and after transitions
that can redirect to login or display an expired-session marker. This converts
stale credentials into an explicit update request instead of misreporting a
product regression.

Do not encode credentials, tokens, storage values, or login form secrets in the
flow. The trusted runner applies the selected profile internally and removes
secret-bearing evidence if it detects disclosure.

## Evidence strategy

The runner always attempts a final or failure screenshot, records video, and
creates a sanitized trace once the browser launches. Add named `screenshot`
steps only at states that materially help explain the result—for example before
and after a destructive interaction, or when a transient success message is
the oracle.

Use evidence by purpose:

- **Screenshot:** quick review of one meaningful visual state.
- **Video:** chronological confirmation of the complete user flow.
- **Trace:** action/DOM timing diagnosis for a failed or flaky interaction.

Assertions determine pass/fail; evidence explains it. Preserve and link every
artifact group returned on both passed and failed runs.

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
sub-agent shutdown and cleanup lifecycle. Authentication config and reusable
auth state are separate persistent inputs and stay under project `.pi/`.
