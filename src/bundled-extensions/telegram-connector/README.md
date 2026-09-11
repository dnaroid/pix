# telegram-connector

Bundled Pix TUI connector for small, actionable Telegram notifications. It is
not a conversation mirror: Telegram receives only completion/error summaries
and structured `question` prompts.

## Setup

Add this to `~/.config/pi/pi-tools-suite.jsonc`:

```jsonc
{
  "telegramConnector": {
    "enabled": true,
    "botToken": "123456789:AA...",
    "chatId": "123456789"
  }
}
```

`enabled` may be omitted. A valid `botToken` plus `chatId` enables the
connector unless `enabled` is explicitly `false`.

Environment overrides are also supported:

- `PIX_TELEGRAM_CONNECTOR=0|1`
- `PIX_TELEGRAM_BOT_TOKEN=<token>`
- `PIX_TELEGRAM_CHAT_ID=<id>`

The token/chat-id environment pair enables the connector by itself.
`PIX_TELEGRAM_CONNECTOR=0` is a hard off switch; `=1` can explicitly re-enable
credentials when the file configuration has `enabled: false`.

The bot accepts input only from the configured chat id.

## Workflow

When a run fully settles, Pix sends a compact message:

```text
✅ Готово · refactor auth · pix

Tests pass.

↩️ Ответьте на это сообщение — продолжить в этой сессии.
🆕 /new <задача> — начать новую сессию.
```

Reply to that Telegram message with normal text to send a new user message to
the exact live Pix session that produced the notification. Reply with
`/new <task>` to create a new session from that session and immediately submit
the task there.

When exactly one live session exists, it can also be the target for a non-reply
message. When several sessions are live, Pix requires a reply to a notification
instead of guessing from notification timing.

When the bundled `question` tool asks something, the connector sends the
question and numbered choices to Telegram and waits for the Telegram answer.
Reply with one number, several numbers separated by commas for multi-select, or
free text. `/cancel` cancels the question without inventing an answer.

Other bot commands:

- `/status` — show the currently focused session and idle/busy state.
- `/help` — show the compact workflow reference.

## Deliberate boundaries

- One Telegram bot token belongs to one running Pix process. This version has
  no Unix-socket leader election or multi-process failover.
- Telegram completion delivery is detached from Pix's idle lifecycle; a slow
  Bot API send cannot hold `agent_settled` or `waitForIdle()`.
- Outbound Bot API sends are bounded. If sending a remote question stalls or
  fails, the question path can fall back locally instead of waiting forever.
- Only one `/new` replacement can be pending for a source session at a time.
- The connector is wired into the Pix TUI runtime. Pix Desktop uses separate
  ACP worker processes and is intentionally not wired to this single-poller
  design, because doing so would make those workers compete for one bot token.
- Assistant thinking, tool calls/results, session transcripts, and file content
  are not mirrored to Telegram.
- Incoming Telegram slash commands other than `/new`, `/status`, and `/help`
  are ordinary user text; the connector never expands them as Pix commands.
- Reply routing is in memory. Replies to notifications from an earlier Pix
  process are rejected rather than guessed.
- On startup the poller discards Telegram's pending backlog before accepting
  new input, so a command left over from an earlier Pix process cannot run
  unexpectedly after restart.
- Telegram transport is best effort and must not fail the agent run.

These boundaries intentionally replace the former `telegram-mirror`, whose
streaming renderer, multiplexer, Unix-socket IPC, and leader election made the
integration much larger than the task-notification workflow requires.
