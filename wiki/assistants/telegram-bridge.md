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

Telegram UI labels are given in English with the Russian client wording in
parentheses.

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather), send `/newbot`, choose a display
   name and a username ending in `bot`. Copy the token
   (`123456789:AA…`). Anyone with the token controls the bot: never commit it.
2. Turn off group privacy: `/setprivacy` → select the bot → **Disable**. An
   administrator bot already receives all group messages, but this removes the
   "has no access to messages" (*не имеет доступа к сообщениям*) restriction
   explicitly. The change applies only to groups the bot joins **afterwards**:
   if the bot is already in the group, remove it and add it again.
3. Optional: `/setcommands` with
   `sessions - running Pix sessions`, `stop - stop the current run`,
   `status - session state`, `id - chat and user ids`, `help - help`.

### 2. Create the forum group

1. Create a new **group** (not a channel) with only yourself, e.g. "Pix".
2. Group settings (✏️ Edit / *Изменить*) → enable **Topics** (*Темы*). This
   turns the group into a forum supergroup; the topic list replaces the chat.
   Telegram shows the *Manage topics* admin right only after topics are on.
3. Add the bot as a member, then **Administrators** (*Администраторы*) → **Add
   admin** (*Добавить администратора*) → the bot. Required right:
   **Manage topics** (*Управление темами*). Nothing else is needed: profile
   changes, deleting/pinning messages, bans, invite links, stories, video
   chats, tags, anonymity and adding admins can all stay off.
4. Keep the group private and do not invite other people: every member listed
   in `allowedUserIds` can make the agent act in your projects.

### 3. Get the ids and write the credentials

Enable the module first (step 4), then in any Pix session:

1. Run `/telegram`. When `~/.config/pi/telegram-bridge.jsonc` does not exist,
   it is created from a commented template (mode 0600, never overwritten) and
   the path is shown.
2. Paste the bot token into `"botToken"`, save, and run `/telegram` again. The
   bridge activates without a reload and reports `chatId is not set` (setup
   mode, the broker only answers `/id`).
3. In the group's **General** topic send `/id`. The bot answers
   `chat id: -100… (forum)` and `your user id: …`. If `(forum)` is missing,
   topics are not enabled. If the bot does not answer, see
   [troubleshooting](#troubleshooting).
4. Complete the file:

   ```jsonc
   {
     "botToken": "123456789:AA…",
     "chatId": -1001234567890,     // the forum group from /id
     "allowedUserIds": [11111111]  // your user id from /id
   }
   ```

5. Run `/telegram` once more (or wait up to 30 s): the broker re-reads the
   file before every poll, so `chatId`/`allowedUserIds` edits apply without
   restarting sessions, and topics appear for every running session. A changed
   `botToken` restarts the broker. Send `/sessions` in General to check.

The file can also be created by hand with the same content. Sessions that
started before the file existed activate on their next `/telegram`, `/reload`
or restart.

There is no Desktop editor for this file: it holds a secret and is
deliberately separate from the synced `pi-tools-suite.jsonc`.

### 4. Enable the module

**In Pix Desktop:** open **Settings** in the sidebar → **Tools Suite** →
**General** → **Modules**, check **telegram-bridge** and save. The setting is
written to `~/.config/pi/pi-tools-suite.jsonc` as
`"modules": { "telegram-bridge": true }`. Already running sessions load
extensions at start, so reopen them or run `/reload` in each session.

**In a config file (TUI or Desktop):** add to `~/.config/pi/pi-tools-suite.jsonc`
and restart/`/reload` the sessions:

```jsonc
"modules": { "telegram-bridge": true }
```

Run `/telegram` in a session to see whether the bridge is connected, whether
this process is the broker and which setup step is missing.

### Troubleshooting

- **No `/telegram` command:** the module is not loaded. Check the Modules
  checkbox and `/reload`; a Desktop build older than the module does not have
  it.
- **`inactive: …`:** the message names the config problem and the file path.
- **Bot silent while `/telegram` says connected:** check the shared log,
  `grep -h 'suite.telegram' ~/.config/pi/logs/*.jsonl | tail`. `poll-failed`
  at error level means the token was rejected; `poll-conflict` means another
  process (or a webhook) polls the same bot.
- Desktop may restore session tabs without starting their runtime; send a
  message or `/telegram` in a session so at least one process runs the broker.

**Disabling:** uncheck **telegram-bridge** in Settings → Tools Suite → General
→ Modules, or set `"telegram-bridge": false` in the same `modules` map. `"enabled": false` in `telegram-bridge.jsonc` also
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
