# Telegram task connector

<!-- markdownlint-disable MD013 -->

> Risk classes: **external integration / privacy / concurrency**. This is the
> current behavior contract for the bundled Telegram task connector.

## Purpose

`telegram-connector` gives a private Telegram chat a small remote-control
surface for live Pix TUI sessions in one process. It reports when work fully
settles or when the bundled `question` tool needs an answer, and accepts an
addressed follow-up or a request to start a fresh session. It intentionally is
not a conversation mirror. `[confirmed by code: src/bundled-extensions/telegram-connector/]`

## Activation and configuration

- The bundled extension is loaded from `src/bundled-extensions/telegram-connector` with the other Pix TUI bundled extensions. `[confirmed by code: src/app/runtime.ts]`
- `telegramConnector` in `~/.config/pi/pi-tools-suite.jsonc` accepts `enabled?`, `botToken`, and `chatId`. Both credentials are required; the credential pair enables the connector unless file config explicitly says `enabled: false`. `[confirmed by code: config.ts; confirmed by schema: src/schemas/pi-tools-suite-schema.ts]`
- `PIX_TELEGRAM_BOT_TOKEN` plus `PIX_TELEGRAM_CHAT_ID` also enables the connector. `PIX_TELEGRAM_CONNECTOR=0` is a hard disable and `=1` explicitly enables otherwise-disabled credentials. `[confirmed by code: config.ts]`
- Incoming messages are accepted only when the Telegram chat id exactly matches the configured id. `[confirmed by code: bot.ts]`

## Pix to Telegram

- `agent_settled`, not `agent_end`, triggers completion notification. Therefore automatic retry, compaction, or queued continuation is allowed to finish before Telegram is notified. User-aborted runs are suppressed. Telegram delivery is detached from the extension handler, so it does not delay the SDK `agent_settled` event or `waitForIdle()`. `[confirmed by code: index.ts; confirmed by SDK contract; confirmed by tests: tests/telegram-connector.test.ts]`
- Completion notifications contain session/project identity, the final assistant-visible text when available (or final failure reason), and instructions for reply or `/new`. `[confirmed by code: index.ts, coordinator.ts]`
- Only assistant text blocks are used for the optional completion summary. Thinking blocks, tool calls/results, and full history are excluded. `[confirmed by code: index.ts]`
- The `question` tool tries the per-session remote-question handler before local UI. When Telegram is connected, numbered/custom Telegram replies become the tool's `QuestionSelection`; `/cancel` or the tool's local `AbortSignal` returns a user-canceled result and clears the pending Telegram route. If the remote bridge is absent or fails before obtaining an answer, normal local/headless question behavior remains available. `[confirmed by code: question/index.ts, question/remote.ts, coordinator.ts; confirmed by tests: tests/telegram-connector.test.ts]`

## Telegram to Pix

- Every completion Telegram `message_id` is mapped in memory to the exact live Pix `sessionId`. A Telegram reply to that notification sends its text through that session's `ExtensionAPI.sendUserMessage`. `[confirmed by code: coordinator.ts, index.ts; confirmed by tests: tests/telegram-connector.test.ts]`
- Non-reply text may target the focused session only when exactly one live session is registered. With two or more live sessions, ordinary text and `/new` without a reply are rejected and the user is asked to reply to the intended session notification. This removes focus-order races between concurrent completions. `[confirmed by code: coordinator.ts; confirmed by tests: tests/telegram-connector.test.ts]`
- `/new <task>` creates a short-lived random request id and asks the addressed source extension to dispatch the internal `/telegram-new-session <request-id>` command with `expandPromptTemplates: true`. The command receives a fresh `ExtensionCommandContext`, waits for idle, calls `ctx.newSession()`, and starts the task through the fresh `withSession` context without keeping the command handler blocked for the entire new agent turn. No stale command context is retained across session replacement, and only one replacement may be pending for a source session at a time. `[confirmed by code: coordinator.ts, index.ts; confirmed by tests: tests/telegram-connector.test.ts]`
- `/status` and `/help` are the only other Telegram commands. Unknown slash-prefixed text is sent as ordinary user text with `expandPromptTemplates` left false, so Telegram cannot invoke arbitrary Pix slash/extension commands. `[confirmed by code: coordinator.ts, index.ts; confirmed by tests: tests/telegram-connector.test.ts]`

## Process and lifecycle model

- A process-global coordinator (stored under `Symbol.for`) owns one long-poll bot client and a registry of live session endpoints. Individual session extension instances attach/detach as SDK session runtimes are created, replaced, or shut down. `[confirmed by code: coordinator.ts, index.ts]`
- Detaching the final endpoint uses a short stop grace so a normal session replacement can attach the successor before the long-poller is torn down. `[confirmed by code: coordinator.ts]`
- The connector deliberately does **not** implement the former telegram-mirror Unix-socket leader/follower protocol. One bot token is expected to be consumed by one Pix process. `[confirmed by docs/code]`
- Routing state is in memory. A reply to a notification from a previous process is rejected instead of being guessed. `[confirmed by code: coordinator.ts]`
- Completion/question routes are revalidated after awaited Bot API sends. If the bot generation or live session endpoint changes while a send is in flight, its stale result is not installed as a live route. Invalid-question feedback re-arms the reply route before its network send and cleans it again on send failure, closing the corrected-reply race window without leaving orphaned pending questions. `[confirmed by code: coordinator.ts; confirmed by tests: tests/telegram-connector.test.ts]`

## Telegram transport

- The client uses native `fetch` against Telegram Bot API `sendMessage` and `getUpdates`; polling first establishes a fresh baseline with `offset: -1` without executing pending updates, then uses a 25-second long-poll timeout and bounded exponential retry backoff. Outbound `sendMessage` requests are bounded to 10 seconds by default and share the bot lifecycle AbortSignal, so a stopped or stalled Telegram client cannot hold a remote question indefinitely. `[confirmed by code: bot.ts; confirmed by tests: tests/telegram-connector.test.ts]`
- Telegram errors are reported to stderr but the integration is best effort and does not fail the agent run. `[confirmed by code: bot.ts, index.ts]`
- Messages are plain text and capped below Telegram's message-size limit. The connector does not edit streamed messages, delete history, parse Markdown to HTML, or send full transcripts. `[confirmed by code: bot.ts, coordinator.ts]`

## Security and privacy invariants

- Only the configured chat id controls the bot. `[confirmed by code: bot.ts]`
- Bot tokens are never included in user-facing error messages, and polling errors redact the token before they are reported to stderr. `[confirmed by code: bot.ts; confirmed by tests: tests/telegram-connector.test.ts]`
- Telegram input can trigger agent turns and therefore downstream tool/file mutations; possession of the configured private chat is an authorization boundary. `[inferred from sendUserMessage behavior]`
- Unknown Telegram slash commands do not get Pix command expansion. `[confirmed by code/tests]`

## Known limits

- Running two Pix processes with the same bot token is unsupported because Telegram `getUpdates` has a single-consumer model and this connector intentionally has no cross-process election. `[confirmed by design/code]`
- Pix Desktop is not wired to this connector. Desktop ACP sessions are separate worker processes; sharing this single-poller connector across those workers would violate the one-process/one-token boundary above. `[confirmed by runtime integration design]`
- Long-poll offsets are in memory, but process startup intentionally discards Telegram's pending backlog before accepting new input. This favors avoiding duplicated/stale task execution over replaying commands that arrived while Pix was not running. `[confirmed by code/tests]`
- The remote question path becomes the active question UI while the connector is available; it does not race Telegram against the local TUI/Desktop question surface. `[confirmed by code]`
- Only text Telegram messages are accepted in this version; images/files are ignored. `[confirmed by code: bot.ts]`

## Tests

`tests/telegram-connector.test.ts` covers config resolution, Bot API input normalization, bounded sends, public command parsing, single/multi question parsing, exact reply-to-session routing, multi-session ambiguity rejection, duplicate `/new` suppression, invalid-question reply races and cleanup, non-blocking `agent_settled`, fresh command-context session creation, remote headless question completion, and completion-summary filtering. `[confirmed by tests]`
