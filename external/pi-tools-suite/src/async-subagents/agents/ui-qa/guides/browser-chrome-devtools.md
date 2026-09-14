# Browser detail: Chrome DevTools

Load this topic only when the browser router or `selection.guide` selected
`chrome-devtools`. Probe/run still goes through `PI_UI_QA_RUNNER`; never invoke
`chrome-devtools` directly from the QA child.

## Runner-owned security boundary

The provider requires a compatible `chrome-devtools-mcp` CLI. The runner owns a
random per-run daemon session and stops only that session. It starts an isolated
Chrome/profile by default and applies fail-closed defaults: JavaScript
evaluation and optional extension/PWA/experimental categories are disabled,
usage statistics and CrUX lookup are disabled, network headers are redacted,
writes are restricted to the run evidence directory, page-id routing is
enabled, and exact target/allowed origins become the network allowlist.

If the CLI/runtime is missing or too old, relay the runner's `BLOCKED` handoff;
do not install or upgrade it from this child.

## Target options

Use `target.browserDriver: "chrome-devtools"` when explicit routing is needed.
`target.profile` is not accepted: trusted QA authentication belongs to the
Playwright route and credentials must never be moved into DevTools arguments,
profiles, environment, or JavaScript.

Optional `target.devtools` fields:

- `headless`: boolean for runner-owned isolated Chrome, default `true`;
- `browserUrl`: exact credential-free loopback HTTP endpoint for an already
  debug-enabled Chrome; remote/non-loopback endpoints are rejected;
- `reuseExistingBrowserSession`: boolean, valid only with `browserUrl`, and only
  when the parent/user explicitly requires the existing authenticated session.

Even when attached, the default is a task-owned isolated page/context. The
runner closes only its created page and private daemon; it never stops external
Chrome or closes unrelated tabs.

Top-level deterministic `environment` is intentionally unsupported on this
route. Split diagnostics into a separate flow instead of approximating the
Playwright locale/timezone/motion contract.

## DevTools flow surface

Common actions supported here:

- navigation/stability: `goto`, `reload`, `waitFor`, `waitForTimeout`;
- interaction: `click`, `doubleClick`, `hover`, `fill`, `press`;
- assertions: `assertVisible`, `assertText`, `assertURL`;
- evidence: `screenshot`.

DevTools-specific actions:

- `snapshotAccessibility`: retain a structured accessibility-tree JSON;
- `assertNoConsoleErrors`: require zero console errors;
- `assertConsole`: match exactly one of `equals`/`includes`, optional `type`;
- `assertNetworkRequest`: exact origin-relative `path`, uppercase `method`,
  numeric `status`; optional `origin` must already be allowlisted;
- `lighthouse`: sanitized summary, mode `navigation` or `snapshot`, optional
  `desktop`/`mobile` device;
- `performanceTrace`: temporary Chrome trace -> bounded numeric/insight summary
  -> raw trace deletion;
- `heapSummary`: temporary heapsnapshot -> sanitized numeric summary -> raw
  snapshot close/deletion.

Locators are deliberately narrow: `{role,name?,exact?}` or `{text,exact?}`.
Each locator resolves against the latest accessibility snapshot to one unique
UID; missing or ambiguous matches fail. If the requested scenario needs richer
locators, frames/popups, trusted profiles, downloads, or actions absent above,
use the Playwright route rather than weakening the test.

## Oracles, privacy, and evidence

Assertions remain the pass/fail oracle. Console/network checks publish only the
bounded matcher result needed for QA; raw network headers and response bodies
are not evidence. Never place secrets in expected console text, paths, or
origins.

Retained DevTools evidence may include explicit PNGs, accessibility snapshots,
sanitized Lighthouse summaries, sanitized performance summaries, and sanitized
heap summaries. Raw performance traces can contain URLs/query strings/network
and call-frame details, so they are temporary. Raw heapsnapshots are temporary
as well. Neither raw form is retained by the runner.

This route does not currently promise automatic browser video, downloads, or a
Playwright trace. Missing evidence types are capability differences, not a
reason to synthesize evidence from another surface.

Inspect representative screenshots before visual claims. Let the runner own
the page/context, daemon, evidence, and cleanup; never issue provider-level
start/stop or tab cleanup commands yourself.
