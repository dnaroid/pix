# telegram-mirror

A pi-tools-suite module that exposes one or more running pi sessions as a
single Telegram chat. Pi stays as the source of truth; Telegram is a remote
second screen.

## Opt-in

The module is a no-op until you add a `telegramMirror` block to
`~/.config/pi/pi-tools-suite.jsonc`:

```jsonc
{
  // …other pi-tools-suite settings…
  "telegramMirror": {
    "enabled": true,
    "botToken": "123456789:ABCdef…",   // from @BotFather
    "chatId": 123456789                // numeric chat id of your private chat
  }
}
```

| Field       | Type              | Required | Notes                                                                                          |
|-------------|-------------------|----------|------------------------------------------------------------------------------------------------|
| `enabled`   | boolean           | no       | Defaults to `true` when the block is present and `botToken` + `chatId` are valid.              |
| `botToken`  | string            | yes      | Telegram Bot API token from [@BotFather](https://t.me/BotFather). Empty string disables.       |
| `chatId`    | number or string  | yes      | Numeric chat id of the private chat allowed to control the bot. Non-integer disables.          |

When the block is present and valid, the module connects on the next `pi`
start (or `/reload`).

## How to get your chat id

Open this URL in a browser (replace `<TOKEN>` with your bot token):

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Send any message to your bot in Telegram, then refresh the URL. The JSON
response contains `"chat": { "id": 123456789, … }` — that number is your
`chatId`.

Alternative: message [@userinfobot](https://t.me/userinfobot).

The bot silently ignores every message from any other chat.

## Multi-instance setup

Telegram allows exactly one concurrent `getUpdates` call per bot token,
so this module elects a **leader** when N pi processes share one bot:

1. The first pi to start binds the unix socket at
   `~/.pi/agent/extensions/pi-tools-suite/.run/telegram-mirror.sock`,
   connects the bot, and starts polling.
2. Subsequent pi processes connect to that socket as **followers**. They
   forward their pix events to the leader over IPC and execute commands
   received from the leader.
3. If the leader dies (process exit, socket close, or heartbeat timeout),
   followers race to bind the socket; the first to win becomes the new
   leader. `activeId` resets on failover — run `/use N` again.

No setup needed: this is fully automatic. Just run more `pi` processes.

When you start a new pi, it logs `[telegram-mirror] registered with
leader <label>` on stderr. The leader logs `[telegram-mirror] connected
as @<botname> (leader)`.

### Selecting the active instance

In Telegram, use `/list` and `/use`:

```
/list
→
1. pi-ui-extend (#12345) (leader) \[active\]
2. opencode (#67890)
3. other-repo (#99999)

Use /use N or /use <id> to switch.
```

```
/use 2
→ ✅ Active: opencode (#67890)
```

`/use` accepts a 1-based index from `/list` or a substring of the id/label.
Events from non-active instances are dropped (silent).

### Cleanup

Socket file: `~/.pi/agent/extensions/pi-tools-suite/.run/telegram-mirror.sock`.

If a pi crashes hard and leaves a stale socket, the next pi to start will
unlink it automatically (bind fails → connect fails → unlink → retry).

## Telegram → pix

| Command           | Effect                                                 |
|-------------------|--------------------------------------------------------|
| Free text         | forwarded to the active pi instance as user message   |
| `/list`           | show all known pi instances, mark active               |
| `/use N` `/use X` | switch active instance (by index or id/label substring)|
| `/abort` `/stop`  | cancel current turn on active                          |
| `/compact`        | trigger context compaction on active                   |
| `/status`         | show idle / streaming state of active                  |
| `/say <msg>`      | explicit send (escape hatch for `/`-prefixed text)     |
| `/disconnect`     | stop the bot cluster-wide (resume with `/reload` in pi)|
| `/new`            | not supported via extension API — run `/new` in pi     |
| `/help`           | show command list                                      |

## Pix → Telegram

The leader subscribes to pix streaming events (its own + followers' via IPC)
and renders one Telegram message per agent turn — but **only for the active
instance**:

- `before_agent_start` → `user: <prompt>`
- `message_update` (`text_delta`) → appended to the active message, edited
  in place at ~1.2 s throttle (Telegram rate-limit friendly).
- `tool_execution_start` → `🔧 tool: <args>` line.
- `tool_execution_end` → `✅ tool: <summary>` or `❌` on error.
- `agent_end` → final flush + `— done —` trailer.

Messages are paginated at 4096 chars (Telegram's per-message limit).
Markdown is converted to Telegram HTML with `**bold**`, `*italic*`,
`` `code` ``, and fenced blocks.

## Disable

Either set `"enabled": false` in the `telegramMirror` block, remove the
block entirely, or add `telegram-mirror` to the `disabledModules` array
in the same config file, then `/reload` pi.

## Known limitations

- `/new` cannot start a fresh session from Telegram. The ExtensionAPI
  exposes `newSession()` only on slash-command handler contexts, not on
  event-handler contexts. Workaround: type `/new` in the pi TUI.
- `pi.sendUserMessage` does not expand pi's own slash commands (calls
  `prompt(..., { expandPromptTemplates: false })` internally), so text
  starting with `/` is sent verbatim to the LLM. The module's own
  `/abort`, `/compact`, `/list`, `/use`, etc. are intercepted before
  `sendUserMessage` is called, so they work.
- The leader uses long polling (35 s timeout) and keeps one outbound
  request open. If your network blocks Telegram, you'll see repeating
  `[telegram-mirror] polling: …` errors in stderr and the bot will back
  off up to 60 s between retries.
- On leader failover, the in-flight streaming output for the active turn
  is lost (the new leader's renderer starts empty). `activeId` also
  resets to the new leader; run `/use N` to switch back to a follower.
- The cluster is single-host only (unix socket). To mirror across
  machines, use separate bot tokens.
- IPC events between session_start and leader-registration can be lost
  for a brief window. Mid-stream output may be cut off.

## Files

| File            | Purpose                                                |
|-----------------|--------------------------------------------------------|
| `index.ts`      | module factory: role selection (leader/follower) + lifecycle |
| `bot.ts`        | Telegram Bot API fetch client + long-poll loop         |
| `ipc.ts`        | unix socket JSON-lines IPC + leader election           |
| `multiplexer.ts`| leader-side registry + active-instance routing         |
| `events.ts`     | pix event → sink adapters + ctx capture                |
| `renderer.ts`   | per-turn buffer, throttled edit, pagination            |
| `format.ts`     | markdown → Telegram HTML, chunking                     |
