# 0073 — Telegram bridge as an in-session extension with an elected broker

- Status: accepted
- Recorded: 2026-11-01
- Decided: 2026-11-01
- Owner / approval evidence: user request in a Claude Code session ("я хочу на
  телефоне работать, подключаться к запущенным проектам, сессиям", primary
  host "десктоп", then "а через телеграм бота?", "давай с темами, и учти, что
  может быть запущено несколько проектов", "это расширение телеграм должно
  легко отключаться в конфиге").
- Governing spec: [Telegram bridge](../assistants/telegram-bridge.md)
- Replaces / replaced by: none

## Context

The user wants to follow and continue *already running* Desktop sessions from
a phone, cheaply, with several projects open at once. Each Desktop window owns
a `pix-acp` process over stdio with exactly one client; every session is a
separate pi RPC process. No second client can attach to a live session.

## Observations and sources

- Verified: suite extensions load into every Desktop and TUI session process
  and can observe `agent_settled`, `message_end`, `ui_prompt_start` and call
  `pi.sendUserMessage` (`@earendil-works/pi-coding-agent` extension types).
- Verified: ACP adopts extension-initiated runs (`beginExtensionRun` in
  `acp/src/acp/pix-acp-agent.ts`), so a turn started from Telegram streams to
  Desktop. Live user messages are not translated by ACP, hence the explicit
  `telegram-bridge:inbound` state channel.
- Telegram allows one `getUpdates` consumer per bot (HTTP 409 otherwise).

## Decision

Ship an opt-in pi-tools-suite module (`defaultEnabled: false`). One forum
topic per session. Inside session processes, an exclusive lock file elects a
single broker that polls Telegram and serves a local socket; every session
connects as a client and re-registers after a takeover. Credentials live in a
separate `telegram-bridge.jsonc`; the switch lives in the suite `modules` map.

## Alternatives

- **Web/mobile client with a WebSocket gateway and JSON-RPC multiplexer in the
  Desktop host:** needs Rust host changes, a new frontend and network exposure;
  larger effort for the same "follow and reply" need. Still possible later.
- **Terminal in the browser (ttyd/tmux) or remote desktop:** zero code but
  does not reach Desktop sessions (ttyd) or is impractical on a phone (VNC).
- **Separate detached daemon process:** the suite runs from a bundled runtime,
  so a daemon entry point needs its own build/launch path and lifecycle
  management; in-process election reuses the existing extension lifecycle.
- **One chat with session switching buttons:** rejected by the user in favor of
  topics, which keep each session's history and routing unambiguous.

## Consequences

- No hosting cost or open port; works for all projects at once.
- Content passes through Telegram (not E2E); mitigated only by redaction,
  an allowlist and the opt-in default.
- The broker role moves between session processes; correctness relies on the
  lock, persisted offset/topic map and client re-registration.
- Dialogs, images and new-session creation are out of scope.

## Revisit when

- Users need to answer dialogs/permissions or start sessions remotely.
- A real remote web client is built (it could replace or complement this).
- Telegram API limits (20 messages/minute per group) become a practical
  bottleneck for many concurrent sessions.
