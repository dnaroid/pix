# 02 — telegram-mirror (as-is spec)

> Risk classes: **privacy / external integration / concurrency**. Exposes one or
> more running pi sessions as a single Telegram chat. Pi is the source of truth;
> Telegram is a remote second screen that can also send user messages back into pi.

## Purpose

Opt-in module that streams assistant-visible output from a pi session to a private
Telegram chat (via a bot), and forwards free-text Telegram messages into the
followed pi session as user messages. Coordinates multiple pi processes behind a
single bot token via leader election over a unix socket. `[confirmed by docs: README.md; confirmed by code: index.ts]`

## Current behavior

### Activation / opt-in
- No-op until a `telegramMirror` block exists in `~/.config/pi/pi-tools-suite.jsonc` with a valid `botToken` and integer `chatId`. `enabled` defaults to true when the block is present and valid; empty `botToken` or non-integer `chatId` disables. `[confirmed by docs/code: README.md, index.ts, config.ts loadTelegramMirrorConfig]`
- Registers slash commands `/telegram-mirror`, `/tg`, `/tg-off`. The bot does **not** connect until one of those is run. `[confirmed by code: index.ts]`
- Can be disabled via `"enabled": false`, removing the block, or adding `telegram-mirror` to `disabledModules`. `[confirmed by docs: README.md]`

### Leader election & multi-instance
- Telegram permits one concurrent `getUpdates` per bot token, so the module elects a leader. `[confirmed by docs/code: README.md, ipc.ts]`
- `tryAcquireLeadership(socketPath)`: `net.createServer().listen()` → success = leader; `EADDRINUSE` → try `net.createConnection()` (1.5s timeout) = follower; if connect also fails (stale socket) → `unlinkSync` and retry listen once; else throw. `[confirmed by code: ipc.ts]`
- **Socket path**: `~/.pi/agent/extensions/pi-tools-suite/.run/telegram-mirror.sock`. `[confirmed by code: ipc.ts DEFAULT_SOCKET_PATH]`
- Leader validates the token via `getMe()`; on failure it `stepDown()` so another pi can try. `[confirmed by code: index.ts becomeLeader]`
- Followers send `{type:"register"}`, receive `{type:"registered"}`, forward events to the leader, and execute commands/queries from the leader. `[confirmed by code: index.ts becomeFollower]`
- Heartbeat: each side pings every 8s; closes after 20s of silence → triggers reconnect/election. `[confirmed by code: ipc.ts]`
- On leader death, followers race to bind; first wins. `activeId` resets on failover (user must `/use N` again). `[confirmed by docs: README.md; confirmed by code]`
- `/tg-off` / `/telegram-mirror stop` / Telegram `/disconnect` → `clusterStandDown`: leader broadcasts `stand_down` to followers, waits ~200ms, then tears down bot + server; `disabled` flag set before teardown so reconnect short-circuits until pi `/reload`. `[confirmed by code: index.ts clusterStandDown]`

### IPC wire protocol (JSON-lines over the unix socket)
- `register`/`registered`, `instance_update`, `ping`/`pong`, `event` (follower→leader), `command`/`command_ack` (leader→follower, matched by `reqId`, 5s timeout), `query`/`query_reply`, `stand_down`. `[confirmed by code: ipc.ts]`
- Malformed JSON lines are silently skipped. `[confirmed by code: ipc.ts consumeBuffer]`

### Telegram bot client (`bot.ts`)
- Native `fetch` to `https://api.telegram.org/bot<token>/<method>`, HTML parse mode. Long-polls `getUpdates` (35s timeout), tracks `lastUpdateId`, dedupes by offset. `[confirmed by code: bot.ts]`
- **Auth gate by chat id**: only `allowedChatId` (= configured `chatId`) is honored; every other chat is silently dropped. For callback queries the sender id is used as a fallback chat id. `[confirmed by code: bot.ts isAllowedChat/getUpdateChatId; confirmed by docs: README.md]`
- Rate-limit friendly: `editMessageText` "message is not modified" 400s are treated as success. `[confirmed by code: bot.ts]`
- Polling backoff: `min(60s, 1000 * 2^min(5,errors-1))`. `[confirmed by code: bot.ts]`
- `deleteKnownMessages`/`/clear` only deletes message ids the bot remembers in this process (Telegram exposes no full-history wipe to bots). `[confirmed by code: bot.ts; confirmed by docs: README.md]`

### Pix → Telegram (rendering)
- One Telegram message per agent turn; only assistant-visible text from the **followed** session is streamed. Tool calls, tool results, and thinking deltas are intentionally **not** mirrored. `[confirmed by docs: README.md; confirmed by code]`
- `message_update` text deltas are buffered and `editMessageText`-ed in place at a ~1.2s throttle; `agent_end` flushes + appends `— done —`. `[confirmed by docs: README.md; confirmed by code: renderer.ts]`
- `agent_start`/`agent_end` from any known session produce compact status signals (e.g. `🟡 repo (#pid) is streaming`). `[confirmed by docs/code: README.md]`
- Messages paginated at 4096 chars; markdown→Telegram HTML for `**bold**`, `*italic*`, `` `code` ``, fenced blocks. `[confirmed by docs/code: README.md, format.ts]`

### Telegram → pix
- Free text → `pi.sendUserMessage(text)`. `pi.sendUserMessage` does **not** expand pi slash commands, so `/`-prefixed text is sent verbatim to the LLM; the module's own commands (`/abort`, `/compact`, `/list`, `/use`, etc.) are intercepted first. `[confirmed by docs/code: README.md, index.ts sendUserMessageSafely]`
- Built-in commands: `/menu`, `/list`, `/use N|X`, `/abort`|`/stop`, `/compact`, `/status`, `/clear`, `/say <msg>`, `/disconnect`, `/help`. `/new` is **not** supported from Telegram (ExtensionAPI limitation). `[confirmed by docs/code: README.md]`
- Leader dispatches `sendUserMessage`/`abort`/`compact` to the followed instance via IPC `command`/`command_ack`; queries (`status`, `dialog`) via `query`/`query_reply`. `[confirmed by code: index.ts handleFollowerCommand/handleFollowerQuery]`
- `sendUserMessageSafely`: on an "agent busy race" error it retries with `{deliverAs:"followUp"}`. `[confirmed by code: index.ts]`
- `currentDialogFromContext`: builds a transcript (≤40 messages, ≤28k chars) from the session branch for the Telegram picker, stripping DCP control markers and tool/thinking blocks. `[confirmed by code: index.ts]`

## Public contracts / inputs / outputs

- **Config** (`telegramMirror` block in `~/.config/pi/pi-tools-suite.jsonc`): `{ enabled?: boolean, botToken: string, chatId: number|string }`. `[confirmed by docs/code: README.md, config.ts]`
- **Slash commands** (local): `/telegram-mirror [status|stop]`, `/tg`, `/tg-off`. `[confirmed by code]`
- **Telegram-side commands**: the set listed above. `[confirmed by docs/code]`
- **IPC file**: `~/.pi/agent/extensions/pi-tools-suite/.run/telegram-mirror.sock` (unlinked on leader `close`, auto-unlinked when stale). `[confirmed by code: ipc.ts]`

## Invariants

- Exactly one process polls `getUpdates` for a given bot token at a time. `[confirmed by code/docs]`
- Only the configured `chatId` can control the bot; all other chats are silently ignored. `[confirmed by code]`
- Pi remains the source of truth; Telegram is a lossy second screen (tool/thinking output not mirrored; events between `session_start` and leader registration can be dropped; in-flight stream is lost on failover). `[confirmed by docs: README.md]`
- Stale-socket recovery: bind fails → connect fails → unlink → retry. `[confirmed by code: ipc.ts]`

## Edge cases

- **No ctx yet / not activated**: `eventSink.push` drops events (role `starting` or no IPC). `[confirmed by code: index.ts]`
- **Bot token rejected by `getMe`**: leader steps down; a pi with a working config can take over. `[confirmed by code: index.ts becomeLeader]`
- **Network blocks Telegram**: repeating `polling:` errors on stderr; backoff up to 60s. `[confirmed by docs/code: README.md]`
- **Leader failover mid-turn**: in-flight streaming output is lost; followed session resets. `[confirmed by docs: README.md]`
- **`/clear`**: best-effort; only deletes message ids this process knows about (plus the `/clear` command message when Telegram allows). Older messages from prior runs may remain. `[confirmed by docs/code: README.md, bot.ts]`
- **`reload`/`fork` `session_shutdown`**: IPC and bot are kept alive intentionally so cluster leadership stays stable. `[confirmed by code: index.ts]`
- **Malformed IPC line**: skipped (JSON parse failure swallowed). `[confirmed by code: ipc.ts]`

## Side effects

- **Outbound network** to `api.telegram.org` (polling + send/edit/delete) from the leader. `[confirmed by code]`
- **Sends user messages into pi** (`pi.sendUserMessage`) from Telegram free text → can trigger model turns / tool execution / file writes downstream. `[confirmed by code]`
- **Reads the session branch** (`ctx.sessionManager.getBranch()`) to build the Telegram picker transcript. `[confirmed by code: index.ts currentDialogFromContext]`
- **Filesystem**: creates/owns the unix socket file; `mkdir -p` on the run dir; unlinks socket on close/stale. `[confirmed by code: ipc.ts]`
- **Logs to stderr** (`[telegram-mirror] …`) so as not to pollute the TUI. `[confirmed by code]`

## Related files

- `external/pi-tools-suite/src/telegram-mirror/index.ts` — module factory, role/lifecycle, command/IPC glue, transcript builder
- `.../bot.ts` — Telegram Bot API client + long-poll loop + chat-id auth gate
- `.../ipc.ts` — unix-socket JSON-lines IPC, leader election, heartbeat, request correlation
- `.../multiplexer.ts` — leader-side registry + active-instance routing
- `.../renderer.ts` — per-turn buffer, throttled edit, pagination
- `.../events.ts` — pix event → sink adapters, abortable-context capture
- `.../format.ts` — markdown→Telegram HTML, chunking
- `.../README.md` — user-facing docs
- `external/pi-tools-suite/src/config.ts` — `loadTelegramMirrorConfig`

## Existing tests

- **No dedicated unit-test file** for `telegram-mirror` in `external/pi-tools-suite/test/`. `[confirmed by tests: glob of test dir]`
- Behavior is documented thoroughly in `README.md` ("Known limitations" enumerates the lossy cases). `[confirmed by docs]`

## Gaps / risks

- **Privacy**: by design this module streams assistant output **and** the session transcript (up to 28k chars / 40 messages, DCP markers stripped but user + assistant text included) to a third party (Telegram), and lets Telegram send user messages that trigger turns/tools/file writes. All gated only on the opt-in config. `[confirmed by code: index.ts currentDialogFromContext, sendUserMessageSafely; confirmed by docs]`
- **Secret in config**: `botToken` is stored in cleartext in `pi-tools-suite.jsonc` and embedded in every outbound URL. `[confirmed by code: bot.ts]`
- **`chatId` auth gate is exact-match only**: if `chatId` is misconfigured (e.g. a group id, or leaked), the bot honors whatever integer is configured; there is no allow-list of multiple chats. `[confirmed by code: bot.ts isAllowedChat]`
- **No tests**: the entire module (leader election, IPC framing, failover, auth gate, message dispatch) is unverified by automated tests — the riskiest concurrency/IO module has the least coverage. `[confirmed by tests]`
- **Single-host only**: unix-socket cluster means cross-machine mirroring requires separate bot tokens; not a limitation the code enforces, just a design boundary. `[confirmed by docs]`
- **`/use` substring matching and `/list` enumeration** expose all known pi sessions (cwd, pid, label, session name) to the Telegram chat. `[confirmed by docs/code: README.md, ipc.ts InstanceInfo]`
- **Stale-socket `unlinkSync`** is best-effort and races: two pis starting near-simultaneously could both unlink a live leader's socket. `[inferred from ipc.ts]`
- **Lost-event windows**: between `session_start` and leader registration, and on failover, output can be cut off mid-stream. `[confirmed by docs]`

## Suggested verification

1. Add unit tests for `ipc.ts` framing (line splitting, malformed-line skip, ping/pong watchdog reset, request timeout/reject on close). `[addresses no-tests risk]`
2. Add a test for `tryAcquireLeadership`: leader → follower → stale-unlink-retry → throw. `[addresses election risk]`
3. Add a test for `bot.ts` chat-id gate (drop non-`allowedChatId` updates) and "not modified" 400 handling. `[addresses auth-gate risk]`
4. Add a test for `clusterStandDown` ordering (`disabled` set before broadcast; followers receive `stand_down`). `[addresses teardown risk]`
5. Document/verify the exact data sent to Telegram for a sample turn (confirm tool results + thinking are excluded, confirm DCP markers stripped) to bound the privacy surface. `[addresses privacy risk]`
