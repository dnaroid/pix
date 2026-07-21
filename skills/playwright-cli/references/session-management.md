# Browser Session Management

Run multiple isolated browser sessions concurrently with state persistence.

## Ownership and cleanup contract

Browser sessions are backed by daemons and can survive the task that created them. Before the first session-scoped command:

1. Generate a unique task-scoped name (semantic purpose plus timestamp/PID or random suffix).
2. Confirm the candidate is absent from `playwright-cli list`, then record the exact name in the task's owned-session list. Do not use `default` for agent automation.
3. Use that exact name on every command. `$SESSION` below is shorthand for the recorded literal, not a shell variable that can be assumed to persist between tool calls.
4. On success, error, cancellation, or timeout, close each session owned by the task individually, then run `playwright-cli list` and verify every owned name is absent. Retry a session-specific close if needed.

Never close a session merely because it looks stale: it may belong to another agent or user. Do not use `close-all` or `kill-all` as normal cleanup.

## Named Browser Sessions

Use `-s` flag to isolate browser contexts:

```bash
AUTH_SESSION="auth-check-$(date +%s)-$$"
PUBLIC_SESSION="public-check-$(date +%s)-$$"
# Browser 1: Authentication flow
playwright-cli -s="$AUTH_SESSION" open https://app.example.com/login

# Browser 2: Public browsing (separate cookies, storage)
playwright-cli -s="$PUBLIC_SESSION" open https://example.com

# Commands are isolated by browser session
playwright-cli -s="$AUTH_SESSION" fill e1 "user@example.com"
playwright-cli -s="$PUBLIC_SESSION" snapshot

# Mandatory cleanup, including error paths
playwright-cli -s="$AUTH_SESSION" close
playwright-cli -s="$PUBLIC_SESSION" close
playwright-cli list  # verify both exact names are absent
```

## Browser Session Isolation Properties

Each browser session has independent:
- Cookies
- LocalStorage / SessionStorage
- IndexedDB
- Cache
- Browsing history
- Open tabs

## Browser Session Commands

```bash
# List all browser sessions
playwright-cli list

# Stop a browser session owned by this task
playwright-cli -s="$OWNED_SESSION" close

# Delete user data for a persistent session owned by this task
playwright-cli -s="$OWNED_SESSION" delete-data
```

## Environment Variable

Set a default browser session name via environment variable:

```bash
export PLAYWRIGHT_CLI_SESSION="env-check-$(date +%s)-$$"
playwright-cli list  # first confirm $PLAYWRIGHT_CLI_SESSION is absent
playwright-cli -s="$PLAYWRIGHT_CLI_SESSION" open example.com
playwright-cli -s="$PLAYWRIGHT_CLI_SESSION" close
playwright-cli list  # verify $PLAYWRIGHT_CLI_SESSION is absent
unset PLAYWRIGHT_CLI_SESSION
```

For agent tasks, prefer an explicit unique `-s=<owned-name>` on every command. Environment variables may not persist across tool calls, and a fixed value such as `mysession` can collide with another task.

## Common Patterns

### Concurrent Scraping

```bash
#!/bin/bash
set -u
# Scrape multiple sites concurrently

sessions=(
  "site1-$(date +%s)-$$-1"
  "site2-$(date +%s)-$$-2"
  "site3-$(date +%s)-$$-3"
)

cleanup() {
  for session in "${sessions[@]}"; do
    playwright-cli -s="$session" close || true
  done
  # Inspect this output and verify every name above is absent.
  playwright-cli list
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Start all browsers
playwright-cli -s="${sessions[0]}" open https://site1.com &
playwright-cli -s="${sessions[1]}" open https://site2.com &
playwright-cli -s="${sessions[2]}" open https://site3.com &
wait

# Take snapshots from each
playwright-cli -s="${sessions[0]}" snapshot
playwright-cli -s="${sessions[1]}" snapshot
playwright-cli -s="${sessions[2]}" snapshot
```

### A/B Testing Sessions

```bash
VARIANT_A="variant-a-$(date +%s)-$$"
VARIANT_B="variant-b-$(date +%s)-$$"
# Test different user experiences
playwright-cli -s="$VARIANT_A" open "https://app.com?variant=a"
playwright-cli -s="$VARIANT_B" open "https://app.com?variant=b"

# Compare
playwright-cli -s="$VARIANT_A" screenshot
playwright-cli -s="$VARIANT_B" screenshot

playwright-cli -s="$VARIANT_A" close
playwright-cli -s="$VARIANT_B" close
playwright-cli list  # verify both exact names are absent
```

### Persistent Profile

By default, browser profile is kept in memory only. Use `--persistent` flag on `open` to persist the browser profile to disk:

```bash
SESSION="persistent-check-$(date +%s)-$$"
# Choose one persistent-profile option. Auto-generated location:
playwright-cli -s="$SESSION" open https://example.com --persistent

# Or a custom directory:
playwright-cli -s="$SESSION" open https://example.com --profile=/path/to/profile

playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Attaching to a Running Browser

Use `attach` to connect to a browser that is already running, instead of launching a new one.

### Attach by channel name

Connect to a running Chrome or Edge instance by its channel name only when the user explicitly requests interaction with that external browser. The browser must have remote debugging enabled — navigate to `chrome://inspect/#remote-debugging` in the target browser and check "Allow remote debugging for this browser instance".

```bash
SESSION="external-debug-$(date +%s)-$$"
# Attach to Chrome
playwright-cli -s="$SESSION" attach --cdp=chrome

# Attach to Chrome Canary
playwright-cli -s="$SESSION" attach --cdp=chrome-canary

# Attach to Microsoft Edge
playwright-cli -s="$SESSION" attach --cdp=msedge

# Attach to Edge Dev
playwright-cli -s="$SESSION" attach --cdp=msedge-dev

# End the CLI attachment without closing the external browser
playwright-cli -s="$SESSION" detach
playwright-cli list  # verify $SESSION is absent
```

Supported channels: `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`, `msedge`, `msedge-beta`, `msedge-dev`, `msedge-canary`.

When `--session` is not provided, the session is named after the channel (for example, `msedge`). Agent tasks must override this with their unique owned name so they do not collide with another task.

### Attach via CDP endpoint

Connect to a browser that exposes a Chrome DevTools Protocol endpoint:

```bash
SESSION="cdp-debug-$(date +%s)-$$"
playwright-cli -s="$SESSION" attach --cdp=http://localhost:9222
playwright-cli -s="$SESSION" detach
playwright-cli list  # verify $SESSION is absent
```

### Attach via browser extension

Connect to a browser with the Playwright extension installed:

```bash
SESSION="extension-debug-$(date +%s)-$$"
playwright-cli -s="$SESSION" attach --extension
playwright-cli -s="$SESSION" detach
playwright-cli list  # verify $SESSION is absent
```

### Detach

Tear down an attached session without affecting the external browser:

```bash
# Detach a specific attached session
playwright-cli -s="$SESSION" detach
playwright-cli list  # verify the exact owned name is absent
```

`detach` only works on sessions created via `attach`. For sessions created via `open`, use `close`.

## Default Browser Session (avoid for agent-created browsers)

When `-s` is omitted, commands use a shared session named `default`. Do not use this legacy behavior for agent-created browsers: ownership is ambiguous and concurrent tasks can collide.

## Browser Session Configuration

Configure a browser session with specific settings when opening:

```bash
SESSION="configured-check-$(date +%s)-$$"
# Choose one of these open configurations.
# Config file:
playwright-cli -s="$SESSION" open https://example.com --config=.playwright/my-cli.json

# Open with specific browser
playwright-cli -s="$SESSION" open https://example.com --browser=firefox

# Open in headed mode
playwright-cli -s="$SESSION" open https://example.com --headed

# Open with persistent profile
playwright-cli -s="$SESSION" open https://example.com --persistent

playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

## Best Practices

### 1. Name Browser Sessions Uniquely and Semantically

```bash
# GOOD: Clear purpose plus a per-task uniqueness suffix.
SESSION="github-auth-$(date +%s)-$$"
playwright-cli -s="$SESSION" open https://github.com
playwright-cli -s="$SESSION" close
playwright-cli list  # verify $SESSION is absent
```

Avoid shared, generic, or reusable names such as `s1` or `github-auth`, and never omit `-s` for a session the task creates.

### 2. Always Clean Up

```bash
# Stop only browsers registered as owned by this task, including on errors.
playwright-cli -s="$AUTH_SESSION" close
playwright-cli -s="$SCRAPE_SESSION" close
playwright-cli list  # verify both exact names are absent
```

### 3. Reserve Global Cleanup for Emergencies

If session-specific `close` repeatedly fails and a daemon is confirmed stale, inspect `playwright-cli list`. Use `kill-all` only if every listed session belongs to the current task or the user approves disrupting foreign sessions. `close-all` has the same ownership risk and is not a shortcut for tracked cleanup. Never use either command to manage the user's ordinary Chrome/Edge processes.

### 4. Delete Stale Browser Data

```bash
# Remove old browser data to free disk space
playwright-cli -s="$OWNED_SESSION" delete-data
```
