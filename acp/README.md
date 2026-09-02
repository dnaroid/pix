# pix-acp

ACP (Agent Client Protocol) adapter that embeds the pi coding agent into ACP
clients such as the Zed Agent Panel. Fork-in-progress of
[pi-acp](https://github.com/svkozak/pi-acp) with pix-specific integrations.

**Status: prompt pipeline + extension UI bridge + session management work
end-to-end.** Each `session/new` spawns a `pi --mode rpc` process;
`session/prompt` forwards text/image content, streams
`agent_message_chunk`/`agent_thought_chunk` and tool calls as
`session/update` notifications, and resolves with a mapped stop reason;
`session/cancel` aborts the run; `session/close` stops the pi process.
Extension dialogs (`ctx.ui.select/confirm/input/editor`) are bridged to ACP
form elicitations when the client advertises `elicitation.form`. Sessions
persist to `~/.pi/agent/pix-acp/sessions.json` enabling `session/list`,
`session/load` (with history replay), `session/resume`, `session/fork`, and
`session/delete`; model & thinking level are exposed as
`session/set_config_option` config options; pi TUI built-in slash commands
(`/compact`, `/name`, `/model`, `/thinking`, …) are intercepted locally while
extension commands, prompt templates and `/skill:*` pass through to pi.

## Architecture

```
Zed (Agent Panel)  <--ACP JSON-RPC over stdio-->  pix-acp  <--JSONL RPC over stdio-->  pi --mode rpc
```

- `src/main.ts` — entry point; wires stdio streams, config, logger.
- `src/acp/pix-acp-agent.ts` — ACP method handlers, the session registry
  (one ACP session → one `pi` process), and the prompt-run lifecycle
  (`agent_start`/`agent_end`/`agent_settled` → ACP stop reason).
- `src/acp/event-translator.ts` — stateful translation of pi
  `JsonAgentSessionEvent`s into ACP `session/update` notifications
  (message/thought chunks, tool calls with titles/kinds/locations, structured
  edit/write diffs).
- `src/acp/ui-request-bridge.ts` — maps pi `extension_ui_request` dialogs to
  ACP form elicitations and the answers back to `extension_ui_response`
  lines on pi's stdin; fire-and-forget UI updates (notify/status/widget) are
  ignored.
- `src/acp/session-map.ts` — persistent ACP↔pi session map
  (`~/.pi/agent/pix-acp/sessions.json` by default) backing
  `session/list`/`load`/`resume`/`fork`/`delete` across adapter restarts.
- `src/acp/config-options.ts` — pi model & thinking level surfaced as ACP
  `configOptions` (grouped provider/model select, thought-level select) and
  applied via `session/set_config_option`.
- `src/acp/session-replay.ts` — replays persisted pi history on
  `session/load` as `user_message_chunk`/`agent_message_chunk` updates plus
  `tool_call`/`tool_call_update` pairs with their results.
- `src/acp/slash-commands.ts` — interception of pi TUI built-in slash
  commands (`/compact`, `/name`, `/export`, `/autocompact`, `/steering`,
  `/follow-up`, `/model`, `/thinking`) inside `session/prompt`; anything
  else starting with `/` (extension commands, templates, `/skill:*`) is
  forwarded to pi unchanged.
- `src/pi/pi-rpc-client.ts` — thin wrapper around the SDK `RpcClient`
  (`@earendil-works/pi-coding-agent`) that spawns `pi --mode rpc`.
- `src/config.ts` / `src/logging.ts` — env config and stderr-only logging.

**stdout is reserved for the protocol stream**; all diagnostics go to stderr.

## Environment

| Variable            | Default                                  | Purpose                                             |
| ------------------- | ---------------------------------------- | --------------------------------------------------- |
| `PIX_ACP_PI_BIN`    | `pi`                                     | Path to the `pi` CLI to spawn                       |
| `PIX_ACP_LOG`       | `info`                                   | Log level: debug, info, warn, error                 |
| `PIX_ACP_SESSION_MAP` | `~/.pi/agent/pix-acp/sessions.json`    | ACP↔pi session map for list/load/resume/fork        |

## Development

```bash
cd acp
npm install --ignore-scripts
npm run check   # tsc --noEmit + node:test
npm run build   # dist/main.js
npm run dev     # run the adapter directly (expects ACP JSON-RPC on stdio)
```

From the repo root: `npm run check:acp`.

The `pi` process spawned by the adapter loads the shared agent environment
(`~/.pi/agent/`), so the pix-installed tools suite, skills, and prompts are
available to it.

## Trying it in Zed

```json
{
	"agent_servers": {
		"pix": {
			"type": "custom",
			"command": "node",
			"args": ["/absolute/path/to/pi-ui-extend/acp/dist/main.js"]
		}
	}
}
```

## Roadmap

Port order follows the mapping layers proven by upstream `pi-acp`
(`src/acp` + `src/pi-rpc`):

1. **Prompt pipeline** — done. `session/new` spawns `PiRpcClient` (cwd from the
   ACP session), `session/prompt` forwards text/images via `prompt()`,
   `session/cancel` maps to `abort()`, `session/close` stops the process.
   `steer()`/`followUp()` are exposed on `PiClient` but not triggered yet:
   ACP SDK 1.4.0 `PromptRequest` has no `promptType` field to distinguish them.
2. **Event translation** — done: `message_update` →
   `agent_message_chunk`/`agent_thought_chunk`, `tool_execution_*` →
   `tool_call`/`tool_call_update` with titles, kinds, locations, raw I/O, and
   structured `diff` content for `edit`/`write`. Live bash output streams via
   the bash tool's throttled `tool_execution_update` snapshots (verified live
   against pi 0.84.4). pi's separate `bash_execution_update` event only fires
   for client-driven `bash` RPC commands and interactive `!` commands — flows
   this adapter never triggers — so it has no ACP mapping and is dropped.
3. **Extension UI bridge** — done. Dialog `extension_ui_request`s
   (select/confirm/input/editor) map to ACP `elicitation/create` (form mode,
   one field), answers map back to `extension_ui_response` lines written to
   pi's stdin. Gated on the client's `elicitation.form` capability: without
   it, dialogs are cancelled immediately so runs never stall. `session/close`
   cancels dialogs still pending an answer. Verified live against a real pi
   0.84.4 with a project-local extension.
4. **Sessions** — done. A persistent session map
   (`~/.pi/agent/pix-acp/sessions.json`) ties ACP session ids to pi session
   files: `session/list` (cwd filter, newest first), `session/load`
   (`switchSession` + history replay as message chunks),
   `session/resume` (switch without replay), `session/fork`
   (`switchSession` + `clone` into a fresh ACP session id), and
   `session/delete`. Model (`provider/id`, grouped) and thinking level are
   exposed as `configOptions` on `session/new`/`load` and applied via
   `session/set_config_option`. pi TUI built-in slash commands are
   intercepted in `session/prompt` and mapped to dedicated RPC commands
   (`/compact`, `/name`, `/export`, `/autocompact`, `/steering`,
   `/follow-up`, `/model [provider/id]`, `/thinking`); other `/…` text
   (extension commands, prompt templates, `/skill:*`) is passed through to
   pi's native expansion. Verified live against pi 0.84.4.
5. **pix extras** — done where the protocol allows: client image attach is
   forwarded through `session/prompt`, and `export_html` is exposed via the
   `/export` slash command (see step 4). Usage/`model-usage-status`
   surfacing is **deferred upstream**: pi 0.84.4's RPC protocol emits no
   usage events, so there is nothing to translate until the SDK grows one.

## Known limitations

- Extension dialogs fired from a blocking `session_start` handler deadlock
  pi's own RPC mode (pi attaches its stdin reader only after startup
  completes), so no adapter can answer them; extensions must not await
  `ctx.ui.*` inside `session_start` (fire-and-forget is fine).
- Dialogs that pi emits while the client cannot answer (no elicitation
  capability) resolve to cancelled/`undefined` — extensions see a dismissal,
  not an error.
- `agent_thought_chunk` is emitted for thinking deltas; clients that do not
  render thoughts will ignore them.
- `session/load` replay emits user/assistant text plus tool calls with their
  results (verified live); thinking blocks are skipped, and the full history
  stays inside pi. Non-text parts of user messages render as `[image]`.
- The session map refreshes `piSessionPath`/`title` from pi state after
  every settled run and on load/resume, so pi-side file moves are tracked;
  session files moved manually while no adapter session is live are not
  discovered (resume then starts a fresh session at the stale path).

Also compare with the advanced fork
[`@victor-software-house/pi-acp`](https://github.com/Victor-Software-House/pi-acp)
(SDK in-process, thought chunks, fs/terminal delegation) for design reference.

## Constraints

- `@earendil-works/pi-coding-agent` is pinned **exactly** (currently `0.84.4`)
  to match the repo-wide SDK pin; bumps go through the `pi-sdk-update` skill.
  The RPC protocol of the spawned `pi` binary must stay in sync with this pin.
- This package is intentionally NOT part of the root `npm run check`
  (it has its own install); run `npm run check:acp` from the repo root.
