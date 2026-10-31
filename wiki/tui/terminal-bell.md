# terminal-bell

Bundled Pix extension that rings the terminal bell, optionally plays a sound,
and can show a desktop notification when a session needs attention.

## Config

Shared pi-tools-suite config (`~/.config/pi/pi-tools-suite.jsonc`):

```jsonc
{
  "terminalBell": {
    "sound": true
  }
}
```

- `terminalBell.sound: false` disables bundled bell sound and bundled
  notifications by default.

## Environment variables

- `PI_TERMINAL_BELL=0` — disable the terminal bell byte.
- `PI_TERMINAL_BELL_FORCE=1` — allow ringing even when stdio TTY detection fails.
- `PI_TERMINAL_BELL_SOUND=0|1` — force sound/notification behavior off or on.
- `PI_TERMINAL_BELL_NOTIFY=0|1` — force desktop notifications off or on.
- `PI_TERMINAL_BELL_DELAY_MS=<ms>` — idle delay before notifying.
- `PI_TERMINAL_BELL_NOTIFY_TITLE=<template>` — notification title template.
- `PI_TERMINAL_BELL_NOTIFY_MESSAGE=<template>` — notification message template.
- `PI_TERMINAL_BELL_ASK_USER_NOTIFY_MESSAGE=<template>` — message used when Pi
  is waiting for a user answer.

Platform-specific variables are still supported, including:

- `PI_TERMINAL_BELL_NOTIFIER`
- `PI_TERMINAL_BELL_NOTIFY_ACTIVATE`
- `PI_TERMINAL_BELL_NOTIFY_SENDER`
- `PI_TERMINAL_BELL_NOTIFY_OSASCRIPT`

## Notification templates

`PI_TERMINAL_BELL_NOTIFY_TITLE` and `PI_TERMINAL_BELL_NOTIFY_MESSAGE` support
these placeholders:

- `{sessionTitle}` — session name when available, otherwise short session id.
- `{sessionName}` — session name only.
- `{sessionId}`
- `{sessionFile}`
- `{sessionFileBase}`
- `{cwd}`
- `{reason}` — final failure reason after retries are exhausted.

Default ask-user message:

```bash
PI_TERMINAL_BELL_ASK_USER_NOTIFY_MESSAGE="{sessionName}"
```

Retry behavior:

- Intermediate automatic model retries do not trigger the stop notification.
- If the session finally fails after all retries are exhausted, the notification
  message can include `{reason}`.
- By default, exhausted-retry failures use the `Pix - error` title and the
  session name as the message body.

Default titles:

```bash
completion: "Pix - complete"
error: "Pix - error"
question: "Pix - question"
```

Default message:

```bash
PI_TERMINAL_BELL_NOTIFY_MESSAGE="{sessionName}"
```

Examples:

```bash
PI_TERMINAL_BELL_NOTIFY_TITLE="Pix - complete"
PI_TERMINAL_BELL_NOTIFY_MESSAGE="{sessionName}"

PI_TERMINAL_BELL_NOTIFY_TITLE="{sessionFileBase}"
PI_TERMINAL_BELL_NOTIFY_MESSAGE="Waiting in {cwd}"

PI_TERMINAL_BELL_NOTIFY_TITLE="Pix - error"
PI_TERMINAL_BELL_NOTIFY_MESSAGE="Failed after retries: {reason}"
```

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"8386307b213d5367e93ab312d3301b43b2a648069adca643a0bdb0c7f0f56cb6","checkedAt":"2026-10-30T23:24:52.842Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":57,"reportLanguage":"ru"} -->
