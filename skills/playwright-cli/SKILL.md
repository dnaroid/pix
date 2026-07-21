---
name: playwright-cli
description: Automate browser interactions, test web pages and work with Playwright tests.
allowed-tools: Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*)
---

# Browser Automation with playwright-cli

## Required session lifecycle

Browser sessions are daemon-backed and can outlive both a command and its task. Treat each session as an owned resource:

1. Before the first session-scoped command, choose a unique, task-scoped name (semantic prefix plus timestamp/PID or random suffix), confirm it is not already in `playwright-cli list`, and record the exact name in task state as owned by this task. Do not create automation in the shared `default` session.
2. Pass that exact name with `-s=<name>` to **every** command. In examples, `$SESSION` is shorthand for the recorded literal; do not assume shell variables persist between tool calls.
3. As soon as the session is created, plan cleanup for success, failure, cancellation, and timeout. In a shell script, install an `EXIT INT TERM` trap immediately after registering the name.
4. Before the final response—and on every error path—run `playwright-cli -s=<owned-name> close`. Then run `playwright-cli list` and verify that the exact owned name is absent. If it remains, retry the session-specific close and investigate before finishing.

Only close sessions registered as owned by the current task. `close-all` and `kill-all` can disrupt other agents or users and are not routine cleanup. Use `kill-all` only as an emergency fallback when session-specific cleanup cannot remove a confirmed stale daemon, after checking `list` and either confirming every listed session is yours or obtaining user approval.

For sessions attached to an external browser, use a unique name but `detach` instead of `close`; do not close the external browser. Only attach to a user's regular Chrome/Edge when explicitly requested. For `--debug=cli` sessions, also stop the background test process that owns the browser and verify its generated session is gone.

## Quick start

```bash
# Pick once and record as owned; use this exact value for the whole task.
SESSION="docs-check-$(date +%s)-$$"
# open new browser
playwright-cli -s="$SESSION" open
# navigate to a page
playwright-cli -s="$SESSION" goto https://playwright.dev
# interact with the page using refs from the snapshot
playwright-cli -s="$SESSION" click e15
playwright-cli -s="$SESSION" type "page.click"
playwright-cli -s="$SESSION" press Enter
# take a screenshot (rarely used, as snapshot is more common)
playwright-cli -s="$SESSION" screenshot
# mandatory task cleanup, including error paths
playwright-cli -s="$SESSION" close
playwright-cli list  # verify the exact value of $SESSION is absent
```

## Commands

Most of the command catalog omits `-s="$SESSION"` for readability. When executing it, always target the unique session registered under [Required session lifecycle](#required-session-lifecycle); session creation and cleanup show the option explicitly.

### Core

```bash
playwright-cli -s="$SESSION" open
# open and navigate right away
playwright-cli -s="$SESSION" open https://example.com/
playwright-cli goto https://playwright.dev
playwright-cli type "search query"
playwright-cli click e3
playwright-cli dblclick e7
# --submit presses Enter after filling the element
playwright-cli fill e5 "user@example.com"  --submit
playwright-cli drag e2 e8
# drop files or data onto an element (from outside the page)
playwright-cli drop e4 --path=./image.png
playwright-cli drop e4 --data="text/plain=hello world"
playwright-cli hover e4
playwright-cli select e9 "option-value"
playwright-cli upload ./document.pdf
playwright-cli check e12
playwright-cli uncheck e12
playwright-cli snapshot
playwright-cli eval "document.title"
playwright-cli eval "el => el.textContent" e5
# get element id, class, or any attribute not visible in the snapshot
playwright-cli eval "el => el.id" e5
playwright-cli eval "el => el.getAttribute('data-testid')" e5
playwright-cli dialog-accept
playwright-cli dialog-accept "confirmation text"
playwright-cli dialog-dismiss
playwright-cli resize 1920 1080
playwright-cli -s="$SESSION" close
```

### Navigation

```bash
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload
```

### Keyboard

```bash
playwright-cli press Enter
playwright-cli press ArrowDown
playwright-cli keydown Shift
playwright-cli keyup Shift
```

### Mouse

```bash
playwright-cli mousemove 150 300
playwright-cli mousedown
playwright-cli mousedown right
playwright-cli mouseup
playwright-cli mouseup right
playwright-cli mousewheel 0 100
```

### Save as

```bash
playwright-cli screenshot
playwright-cli screenshot e5
playwright-cli screenshot --filename=page.png
playwright-cli pdf --filename=page.pdf
```

### Tabs

```bash
playwright-cli tab-list
playwright-cli tab-new
playwright-cli tab-new https://example.com/page
playwright-cli tab-close
playwright-cli tab-close 2
playwright-cli tab-select 0
```

### Storage

```bash
playwright-cli state-save
playwright-cli state-save auth.json
playwright-cli state-load auth.json

# Cookies
playwright-cli cookie-list
playwright-cli cookie-list --domain=example.com
playwright-cli cookie-get session_id
playwright-cli cookie-set session_id abc123
playwright-cli cookie-set session_id abc123 --domain=example.com --httpOnly --secure
playwright-cli cookie-delete session_id
playwright-cli cookie-clear

# LocalStorage
playwright-cli localstorage-list
playwright-cli localstorage-get theme
playwright-cli localstorage-set theme dark
playwright-cli localstorage-delete theme
playwright-cli localstorage-clear

# SessionStorage
playwright-cli sessionstorage-list
playwright-cli sessionstorage-get step
playwright-cli sessionstorage-set step 3
playwright-cli sessionstorage-delete step
playwright-cli sessionstorage-clear
```

### Network

```bash
playwright-cli route "**/*.jpg" --status=404
playwright-cli route "https://api.example.com/**" --body='{"mock": true}'
playwright-cli route-list
playwright-cli unroute "**/*.jpg"
playwright-cli unroute
```

### DevTools

```bash
playwright-cli console
playwright-cli console warning
playwright-cli requests
playwright-cli request 5
playwright-cli run-code "async page => await page.context().grantPermissions(['geolocation'])"
playwright-cli run-code --filename=script.js
playwright-cli tracing-start
playwright-cli tracing-stop
playwright-cli video-start video.webm
playwright-cli video-chapter "Chapter Title" --description="Details" --duration=2000
playwright-cli video-stop

# launch the dashboard for UI review / design feedback — user annotates the page, you receive the annotated screenshot, snapshot, and notes
playwright-cli show --annotate

# generate a Playwright locator for an element from its ref or selector
playwright-cli generate-locator e5 --raw

# show a persistent highlight overlay for an element, optionally with a custom style
playwright-cli highlight e5
playwright-cli highlight e5 --style="outline: 3px dashed red"
# hide a single element highlight, or all page highlights when no target is given
playwright-cli highlight e5 --hide
playwright-cli highlight --hide
```

## Raw output

The global `--raw` option strips page status, generated code, and snapshot sections from the output, returning only the result value. Use it to pipe command output into other tools. Commands that don't produce output return nothing.

```bash
playwright-cli --raw eval "JSON.stringify(performance.timing)" | jq '.loadEventEnd - .navigationStart'
playwright-cli --raw eval "JSON.stringify([...document.querySelectorAll('a')].map(a => a.href))" > links.json
playwright-cli --raw snapshot > before.yml
playwright-cli click e5
playwright-cli --raw snapshot > after.yml
diff before.yml after.yml
TOKEN=$(playwright-cli --raw cookie-get session_id)
playwright-cli --raw localstorage-get theme
```

For structured output wrapping every reply as JSON, pass --json
```bash
playwright-cli list --json
```

## Open parameters
```bash
# Use specific browser when creating session
playwright-cli -s="$SESSION" open --browser=chrome
playwright-cli -s="$SESSION" open --browser=firefox
playwright-cli -s="$SESSION" open --browser=webkit
playwright-cli -s="$SESSION" open --browser=msedge

# Use persistent profile (by default profile is in-memory)
playwright-cli -s="$SESSION" open --persistent
# Use persistent profile with custom directory
playwright-cli -s="$SESSION" open --profile=/path/to/profile

# Connect to browser via Playwright Extension
playwright-cli -s="$SESSION" attach --extension=chrome

# Connect to a running Chrome or Edge by channel name
playwright-cli -s="$SESSION" attach --cdp=chrome
playwright-cli -s="$SESSION" attach --cdp=msedge

# Connect to a running browser via CDP endpoint
playwright-cli -s="$SESSION" attach --cdp=http://localhost:9222

# Start with config file
playwright-cli -s="$SESSION" open --config=my-config.json

# Close and verify an owned browser
playwright-cli -s="$SESSION" close
playwright-cli list
# Detach from an attached browser (leaves the external browser running)
playwright-cli -s="$SESSION" detach
# Delete user data for the default session
playwright-cli delete-data
```

## Snapshots

After each command, playwright-cli provides a snapshot of the current browser state.

```bash
> playwright-cli goto https://example.com
### Page
- Page URL: https://example.com/
- Page Title: Example Domain
### Snapshot
[Snapshot](.playwright-cli/page-2026-02-14T19-22-42-679Z.yml)
```

You can also take a snapshot on demand using `playwright-cli snapshot` command. All the options below can be combined as needed.

```bash
# default - save to a file with timestamp-based name
playwright-cli snapshot

# save to file, use when snapshot is a part of the workflow result
playwright-cli snapshot --filename=after-click.yaml

# snapshot an element instead of the whole page
playwright-cli snapshot "#main"

# limit snapshot depth for efficiency, take a partial snapshot afterwards
playwright-cli snapshot --depth=4
playwright-cli snapshot e34

# include each element's bounding box as [box=x,y,width,height]
playwright-cli snapshot --boxes
```

## Targeting elements

By default, use refs from the snapshot to interact with page elements.

```bash
# get snapshot with refs
playwright-cli snapshot

# interact using a ref
playwright-cli click e15
```

You can also use css selectors or Playwright locators.

```bash
# css selector
playwright-cli click "#main > button.submit"

# role locator
playwright-cli click "getByRole('button', { name: 'Submit' })"

# test id
playwright-cli click "getByTestId('submit-button')"
```

## Browser Sessions

```bash
# Choose a unique name once and register it as owned by this task.
SESSION="profile-check-$(date +%s)-$$"
# Choose either persistent option, not both.
# Auto-generated profile location:
playwright-cli -s="$SESSION" open example.com --persistent
# Or a manually specified profile directory (only when requested explicitly):
playwright-cli -s="$SESSION" open example.com --profile=/path/to/profile
playwright-cli -s="$SESSION" click e6
playwright-cli -s="$SESSION" delete-data  # delete user data if requested
playwright-cli -s="$SESSION" close        # mandatory on success and errors
playwright-cli list                        # verify $SESSION is absent

playwright-cli list
```

The global commands `playwright-cli close-all` and `playwright-cli kill-all` may affect sessions owned by others. Do not use them for this workflow; follow the emergency-only policy above.

## Installation

If global `playwright-cli` command is not available, try a local version via `npx playwright-cli`:

```bash
npx --no-install playwright-cli --version
```

When local version is available, use `npx playwright-cli` in all commands. Otherwise, install `playwright-cli` as a global command:

```bash
npm install -g @playwright/cli@latest
```

## Example: Form submission

```bash
SESSION="form-check-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://example.com/form
playwright-cli -s="$SESSION" snapshot

playwright-cli -s="$SESSION" fill e1 "user@example.com"
playwright-cli -s="$SESSION" fill e2 "password123"
playwright-cli -s="$SESSION" click e3
playwright-cli -s="$SESSION" snapshot
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Example: Multi-tab workflow

```bash
SESSION="tabs-check-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://example.com
playwright-cli -s="$SESSION" tab-new https://example.com/other
playwright-cli -s="$SESSION" tab-list
playwright-cli -s="$SESSION" tab-select 0
playwright-cli -s="$SESSION" snapshot
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Example: Debugging with DevTools

```bash
SESSION="devtools-check-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://example.com
playwright-cli -s="$SESSION" click e4
playwright-cli -s="$SESSION" fill e7 "test"
playwright-cli -s="$SESSION" console
playwright-cli -s="$SESSION" requests
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

```bash
SESSION="trace-check-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://example.com
playwright-cli -s="$SESSION" tracing-start
playwright-cli -s="$SESSION" click e4
playwright-cli -s="$SESSION" fill e7 "test"
playwright-cli -s="$SESSION" tracing-stop
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Example: Interactive session

Ask the user for UI review or design feedback. The user draws boxes on the live page and types comments; you receive the annotated screenshot, the snapshot of the marked region, and the user's notes. Use this whenever the user asks for "UI review", "design feedback", or to "ask the user what they think / want / mean":

```bash
SESSION="ui-review-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://example.com
playwright-cli -s="$SESSION" show --annotate
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Specific tasks

* **Running and Debugging Playwright tests** [references/playwright-tests.md](references/playwright-tests.md)
* **Request mocking** [references/request-mocking.md](references/request-mocking.md)
* **Running Playwright code** [references/running-code.md](references/running-code.md)
* **Browser session management** [references/session-management.md](references/session-management.md)
* **Spec-driven testing (plan / generate / heal)** [references/spec-driven-testing.md](references/spec-driven-testing.md)
* **Storage state (cookies, localStorage)** [references/storage-state.md](references/storage-state.md)
* **Test generation** [references/test-generation.md](references/test-generation.md)
* **Tracing** [references/tracing.md](references/tracing.md)
* **Video recording** [references/video-recording.md](references/video-recording.md)
* **Inspecting element attributes** [references/element-attributes.md](references/element-attributes.md)
