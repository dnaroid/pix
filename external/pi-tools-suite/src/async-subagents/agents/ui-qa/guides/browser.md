# Browser backend router

Load this guide only after the common UI-QA role classified the requested
surface as `browser`. Use only the unified `PI_UI_QA_RUNNER` for probe/run.
Provider-specific tools are runner implementation details and must not be
invoked directly by the QA child.

## Choose one detail route

Choose from the requested proof, never from a repository/app name:

- ordinary repeatable browser E2E, rich semantic/form locators, deterministic
  browser environment, downloads, frames/popups, automatic video/trace, or
  trusted QA authentication -> `playwright`;
- browser-runtime diagnostics such as accessibility-tree snapshots,
  console/network assertions, Lighthouse, performance summaries, or memory
  summaries -> `chrome-devtools`;
- authentication setup/update work -> load `auth` first, then use the
  `playwright` detail guide for the verification flow.

Load only the needed topic:

```sh
node "$PI_UI_QA_RUNNER" guide --backend browser --topic playwright
node "$PI_UI_QA_RUNNER" guide --backend browser --topic chrome-devtools
node "$PI_UI_QA_RUNNER" guide --backend browser --topic auth
```

`target.browserDriver` accepts `"auto"`, `"playwright"`, or
`"chrome-devtools"`. Use `auto` when the flow itself makes the required
capability unambiguous. When you must load a detail guide before authoring its
provider-specific steps, explicitly set the matching driver for preflight.
`target.profile` is a trusted-auth input and therefore routes to Playwright.

After every completed-flow `probe`, `selection.guide` is authoritative. It must
be `{ "backend": "browser", "topic": <the detail guide you are following> }`
before `run`. If it differs, load that returned topic, fix the flow if needed,
and probe again. Never weaken the requested proof merely to fit another
provider.

## Common browser flow

The unified flow is declarative JSONC under
`$PI_SUBAGENT_AGENT_DIR/ui-qa/flows/`:

```jsonc
{
  "version": 1,
  "target": {
    "url": "https://example.test/",
    "browserDriver": "auto"
  },
  "steps": []
}
```

The target may use `url`/`baseUrl`, exact `allowedOrigins`, the selected
`browserDriver`, and provider-specific fields documented by the loaded detail
guide. Never put credentials, tokens, raw executable JavaScript, wildcard
origins, or inferred sibling domains in a flow. A profile id and target URL are
non-secret; credential values remain runner-owned.

Treat discovery as a short preflight. Identify the real requested URL, the
smallest user action that exercises the behavior, and a deterministic
product-visible postcondition. A successful click/navigation is not proof.
Verification uses one `run` per requested profile/variant; explicitly
exploratory QA may use at most three bounded runs with one hypothesis each.

Prefer state-based waits/assertions over sleeps. Preserve a product mismatch as
a failure rather than changing the oracle. Additional origins must be exact
`http(s)` origins explicitly justified by the requested scenario.

## Evidence and reporting

Report every artifact returned by the unified runner, including failed runs.
Inspect at least one meaningful screenshot with `read` before claiming visual
QA. Deterministic assertions determine PASS/FAIL; screenshots/video/traces
explain the result.

Let the runner own browser contexts/pages, provider processes, private evidence
directories, and cleanup. Do not create shared/default browser sessions outside
the runner or copy private QA evidence into a persistent shared directory.
