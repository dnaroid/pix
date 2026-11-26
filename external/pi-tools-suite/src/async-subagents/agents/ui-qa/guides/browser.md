# Browser QA: Chrome Control

Run `probe` and `run` through `node "$PI_UI_QA_RUNNER"`. This is the complete
browser guide; there is no provider topic. The sole driver is `chrome-control`.
It uses Apple Events on macOS. It needs Google Chrome already running with a
window, permission for the launching app under macOS **Privacy & Security →
Automation**, and Chrome **View → Developer → Allow JavaScript from Apple
Events**. Screenshots additionally need **Screen Recording** permission.
Background Chrome processes do not count as browser instances. If several
regular Chrome instances are running, the runner returns
`chrome-instance-ambiguous` without touching tabs. Leave only the intended
instance running; multiple windows or profiles in it are fine.

The runner opens its own tab in the front Chrome window. **The tab shares the
current profile, cookies and session; this is not an isolated browser.** Use
only the explicitly requested target. If the intended profile is wrong, ask
the user to switch Chrome profiles first. Users sign in, handle MFA, or solve
CAPTCHA themselves in Chrome. Never automate login, embed secrets in a flow,
access stored credentials, or perform unrequested account/data changes. The
runner does not read or create `.pi/qa_auth.jsonc`.

```json
{
  "version": 1,
  "target": { "url": "http://localhost:3000/" },
  "steps": [
    { "action": "assertVisible", "locator": { "testId": "search" } },
    { "action": "fill", "locator": { "testId": "search" }, "value": "example" },
    { "action": "click", "locator": { "testId": "submit-search" } },
    { "action": "assertText", "locator": { "css": "main h1" }, "includes": "Results" },
    { "action": "screenshot", "name": "search-results" }
  ]
}
```

- `target.url` or `target.baseUrl`: one HTTP(S) URL without embedded
  credentials. The runner loads it before the first step. `goto` takes an
  absolute or relative `url` on that origin; `reload` takes no options.
- `click`, `fill`, `waitFor`, `assertVisible`, `assertHidden`, `assertText`,
  `assertValue`, `assertCount`: use one locator, `testId` or `css`. `fill` takes a
  non-sensitive string `value`. Password/file inputs are not supported.
  `waitFor` accepts `visible` (default), `hidden`, `attached`, or `detached`.
  `assertCount` takes integer `count`. `assertText`, `assertValue`, `assertURL`
  take exactly one string matcher, `equals` or `includes`. `assertURL` uses
  the full URL and takes no locator. State checks retry briefly, within the
  runner deadline and optional top-level `timeoutMs`.
- `screenshot`: optional short `name`. This is a **Chrome window** PNG, not a
  page-only capture. The driver may briefly select the QA tab; it attempts to
  restore the previous tab without overriding a user switch. Capture requires
  a uniquely identified on-screen Chrome window; minimize or close an unrelated
  matching window only with the user's involvement. Do not switch tabs or Spaces
  during capture. Evidence can include browser UI and tab titles; do not capture
  sensitive pages or windows.

Clicks and fills use synthetic DOM events, not trusted native input. The runner
checks the owned tab's page origin before acting; it cannot block redirects or
subresource traffic. Do not claim network isolation. Headless execution,
viewport/environment overrides, other tabs, frame/popup flows, DevTools
diagnostics, downloads, video and traces are not supported. If a required
capability is missing, return `BLOCKED`; don't weaken the proof or fall back
to another driver. Keep the window open until the runner closes its own tab.
