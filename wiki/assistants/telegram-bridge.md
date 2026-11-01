---
kind: spec
status: active
---

# Telegram bridge (remote sessions from a phone)

<!-- markdownlint-disable MD013 -->

## Type

Feature contract and setup guide.

## Lifecycle

Active, opt-in. Implemented by the `telegram-bridge` pi-tools-suite module
(`external/pi-tools-suite/src/telegram-bridge/`); rationale in
[decision 0073](../decisions/0073-telegram-session-bridge.md).

## Goal

Follow and drive running Pix sessions from a phone without exposing a web UI or
a port: every running Desktop/TUI session, in every open project, gets its own
topic in a private Telegram forum group. The agent's answers arrive there, and
messages written in a topic go to that session as user messages.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Create a **private group**, enable **Topics** in its settings, add the bot
   and make it an administrator with the *Manage topics* right.
3. Write the credentials to `~/.config/pi/telegram-bridge.jsonc` (keep it
   private, e.g. `chmod 600`):

   ```jsonc
   {
     "botToken": "123456:ABC…",
     "chatId": -1001234567890,     // the forum group
     "allowedUserIds": [11111111]  // who may drive sessions
   }
   ```

   To find the ids, enable the module with only `botToken` set, then send `/id`
   in the group: the bot answers with the chat id and your user id.
4. Enable the module in `~/.config/pi/pi-tools-suite.jsonc` (or in Desktop
   Settings → tools suite modules) and restart the sessions or `/reload`:

   ```jsonc
   "modules": { "telegram-bridge": true }
   ```

**Disabling:** set `"telegram-bridge": false` in the same `modules` map (or
untoggle it in Settings). `"enabled": false` in `telegram-bridge.jsonc` also
deactivates it without removing the credentials. Environment overrides:
`PIX_TELEGRAM_BOT_TOKEN`, `PIX_TELEGRAM_CHAT_ID`,
`PIX_TELEGRAM_ALLOWED_USER_IDS` (comma-separated), `PIX_TELEGRAM_BRIDGE_CONFIG`
(config path) and `PIX_TELEGRAM_BRIDGE_DIR` (state directory, default
`~/.pi/agent/telegram-bridge/`). The `/telegram` command shows the bridge state
of the current session.

The Mac must be awake and Pix running; nothing is hosted elsewhere.

## Behavior

### Topics

- One forum topic per session, named `<project folder> · <session title>`
  (`new session` until titled) and renamed when the session title changes.
  Topics of the same project share an icon color, so several open projects
  stay visually grouped.
- The session→topic map persists in `state.json`; reopening a session reopens
  and reuses its topic. A topic deleted by hand is recreated on the next
  message.
- When a session ends (tab closed, Desktop quit, process exit), the topic gets
  "Session closed in Pix." and is closed after a 15 s grace period. A reload
  or broker takeover inside the grace period causes no topic churn.

### From Pix to Telegram

- After each settled agent run: the final assistant text (`✅`), or the
  provider error (`⚠️`), or `⏹ Stopped.` for an aborted run. Intermediate
  messages, thinking and tool output are not forwarded.
- `❓ Waiting for your answer in Pix` when the session blocks on a dialog;
  dialogs themselves are answered in Desktop.
- Text is redacted with the credential-firewall `SecretRedactor` before it
  leaves the session process. Answers longer than three messages are sent as
  the first part plus an `answer.md` document.

### From Telegram to Pix

- A text message in a session topic becomes a user message of that session:
  sent immediately when idle, queued as a follow-up while the agent is
  running. The bot reacts with 👀 once the session accepted it. In Desktop the
  message appears immediately as a user row (ACP channel
  `telegram-bridge:inbound` → `user_message_chunk`).
- `/stop` aborts the current run, `/status` shows whether the session runs,
  `/sessions` (anywhere) lists running sessions grouped by project with topic
  links, `/help` and `/id` are informational.
- Messages from users outside `allowedUserIds`, from other chats, from bots
  and non-text messages are not delivered. A message to a session that is not
  running gets a reply saying so.

### Which sessions participate

Pix Desktop sessions (ACP RPC processes) and interactive TUI sessions.
Sub-agents (the module is disabled in their environment and `PI_SUBAGENT_META`
is checked), print/JSON runs and helper RPC processes do not create topics.

## Architecture

```
Telegram ⇄ long polling ⇄ broker (inside one pi session process)
                              ⇅ local socket (NDJSON)
             telegram-bridge extension in every session process
```

- **Leader election.** The first session process that creates
  `broker.lock` (exclusive create, holding its pid) becomes the broker: it
  owns `getUpdates` polling, the Bot API send queue and the socket
  (`broker.sock`, mode 0600; a per-user named pipe on Windows). Every session
  process, including the broker's own, connects to it as a client. A lock
  whose pid is dead is reclaimed.
- **Takeover.** When the broker process exits or quits/reloads its session, the
  remaining clients see the socket close, one of them takes the lock, and all
  clients re-send their registrations. The update offset and topic map are
  persisted, so no messages are lost or duplicated by Telegram and no topic is
  recreated.
- **Delivery.** Outbound calls are serialized and honor `429 retry_after`;
  per-session operations (create/rename/reopen topic, messages, close) run in
  order. The server and sockets are `unref`-ed and never keep a session
  process alive.
- **Diagnostics.** Poll/send failures, takeovers and setup problems go to the
  shared diagnostic log as `suite.telegram` records without message text or
  tokens.

## Security notes

- Telegram is not end-to-end encrypted: forwarded answers and your messages
  pass through Telegram servers. Do not enable the bridge for projects whose
  content must not leave the machine.
- Anyone in `allowedUserIds` can make the agent act in your projects with your
  tools and credentials. Keep the list to yourself and the group private.
- The bot token grants control of the bot; keep `telegram-bridge.jsonc`
  private. It is deliberately separate from the shared `pi-tools-suite.jsonc`.

## Non-goals and limits

- Answering Desktop dialogs/permissions or the question tool from Telegram.
- Starting new sessions or opening projects from Telegram.
- Images, files and voice messages from Telegram.
- Streaming partial output or tool activity.

## Verification

- `external/pi-tools-suite/test/telegram-bridge.test.ts` — config, protocol,
  formatting, broker routing across projects, topic lifecycle, lock and
  takeover over a real socket, extension delivery/redaction.
- `acp/test/agent.test.ts` — "external (Telegram) user messages reach Desktop
  as live user rows".
