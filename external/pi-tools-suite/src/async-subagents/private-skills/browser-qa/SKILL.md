---
name: browser-qa-private
description: Private workflow for deterministic browser bug reproduction and fix verification with redacted project auth and Playwright evidence.
---

# Browser QA

Use the bundled runner; do not read, print, grep, copy, or edit credential values
from `.pi/qa_auth.jsonc` yourself.

## Workflow

1. Resolve `scripts/browser-qa-runner.mjs` relative to this skill.
2. Run `node <runner> profiles`. Choose a profile only when the task names its
   id or safe profile traits make the choice unambiguous. Otherwise stop with
   `QA_PROFILE_REQUIRED` and list only ids, descriptions, and traits.
3. Inspect the target code and write a declarative JSONC flow under
   `.pi/qa-flows/`. Never put credentials or executable JavaScript in it.
4. Run:
   `node <runner> run --profile <id> --base-url <url> --flow <flow.jsonc>`.
   Profile id, URL, and flow path are non-secret; never pass credentials as
   arguments or environment variables.
5. Report deterministic assertions and the runner's screenshot, video, and
   trace paths. Visual inspection supplements assertions; it does not replace
   them.

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
    { "action": "assertText", "locator": { "testId": "toast" }, "includes": "Saved" }
  ]
}
```

The runner owns Playwright/browser lifecycle, strict network-origin boundaries,
auth application, assertions, screenshots, video, trace sanitization, and
cleanup. Do not start an additional shared/default browser session. For multiple
profiles, invoke the runner separately; each invocation gets an isolated context
and exclusive evidence directory.

If the runner returns `QA_AUTH_UPDATE_REQUIRED`, stop and relay only its profile,
file, and reason fields so the parent can ask the user to update auth and rerun.
Do not attempt to recover by exposing or replaying credentials.

See `references/qa-auth.example.jsonc` and `references/qa-flow.example.jsonc`.
