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

- `enabled` (boolean, optional): defaults to `true` when the block is
  present and `botToken` + `chatId` are valid.
- `botToken` (string, required): Telegram Bot API token from @BotFather.
  Empty string disables the mirror.
- `chatId` (number or string, required): numeric private chat id allowed to
  control the bot. Non-integer disables the mirror.

When the block is present and valid, the module registers the local
`/telegram-mirror` and `/tg` slash commands. The bot does not connect until
you run one of those commands in a pi session.

## Activation

Run this inside each pi session you want to expose to Telegram:

```text
/telegram-mirror
```

Short alias:

```text
/tg
```

Useful local variants:

- `/telegram-mirror` or `/tg`: connect this pi session to Telegram mirror.
- `/telegram-mirror status`: show local mirror role and session label.
- `/telegram-mirror stop`: stop the mirror cluster.
- `/tg-off`: stop the mirror cluster.

After activation, the leader sends a Telegram message with buttons. Use
`/menu` or `/list` in Telegram any time to reopen the project/session picker.

## How to get your chat id

Open this URL in a browser (replace `<TOKEN>` with your bot token):

```text
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

Run `/telegram-mirror` in every `pi` process you want available in the
Telegram picker. Only one process polls Telegram; the rest register as
followers over IPC.

When you start a new pi, it logs `[telegram-mirror] registered with
leader <label>` on stderr. The leader logs `[telegram-mirror] connected
as @<botname> (leader)`.

### Selecting the followed project/session

In Telegram, use `/menu`, `/list`, or the inline buttons:

```text
/list
→
1. pi-ui-extend (#12345) (leader) [following] — idle
2. opencode (#67890) — streaming
3. other-repo (#99999)

Tap a button below, or use /use N.
```

```text
/use 2
→ ✅ Following: opencode (#67890)
```

`/use` accepts a 1-based index from `/list` or a substring of the id/label.
Assistant messages are streamed only from the followed session. Status changes
from other sessions still produce Telegram signals, so you can see when a
different session starts or finishes work without switching to it.

### Cleanup

Socket file: `~/.pi/agent/extensions/pi-tools-suite/.run/telegram-mirror.sock`.

If a pi crashes hard and leaves a stale socket, the next pi to start will
unlink it automatically (bind fails → connect fails → unlink → retry).

## Telegram → pix

- Free text: forwarded to the followed pi session as a user message.
- `/menu`: show inline project/session picker buttons.
- `/list`: show all known pi sessions and mark followed.
- `/use N` or `/use X`: follow by index, id, or label substring.
- `/abort` or `/stop`: cancel current turn on followed session.
- `/compact`: trigger context compaction on followed session.
- `/status`: show idle / streaming state of followed session.
- `/clear`: best-effort delete known bot messages from the chat.
- `/say <msg>`: explicit send, for `/`-prefixed text.
- `/disconnect`: stop the bot cluster-wide.
- `/new`: not supported via extension API; run `/new` in pi.
- `/help`: show command list.

## Pix → Telegram

The leader subscribes to pix streaming events (its own + followers' via IPC)
and renders one Telegram message per agent turn — but only assistant-visible
text from the followed session is streamed:

- `message_update` (`text_delta`) → appended to the active message, edited
  in place at ~1.2 s throttle (Telegram rate-limit friendly).
- `agent_end` → final flush + `— done —` trailer.
- `agent_start` / `agent_end` from any known session → compact status signal
  such as `🟡 repo (#pid) is streaming` or `🟢 repo (#pid) is idle`.

Tool calls, tool results, and thinking deltas are intentionally not mirrored
to Telegram.

Telegram does not expose a full private-chat history wipe API to bots. The
`/clear` command therefore deletes the messages the bot knows about in this
process, plus the `/clear` command message when Telegram allows it. Older
messages from previous bot runs may remain.

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
- On leader failover, the in-flight streaming output for the followed turn
  is lost (the new leader's renderer starts empty). The followed session also
  resets to the new leader; run `/use N` to switch back to a follower.
- The cluster is single-host only (unix socket). To mirror across
  machines, use separate bot tokens.
- IPC events between session_start and leader-registration can be lost
  for a brief window. Mid-stream output may be cut off.

## Files

- `index.ts`: module factory, activation command, role selection, lifecycle.
- `bot.ts`: Telegram Bot API fetch client and long-poll loop.
- `ipc.ts`: unix socket JSON-lines IPC and leader election.
- `multiplexer.ts`: leader-side registry and active-instance routing.
- `events.ts`: pix event to sink adapters and context capture.
- `renderer.ts`: per-turn buffer, throttled edit, pagination.
- `format.ts`: markdown to Telegram HTML and chunking.
