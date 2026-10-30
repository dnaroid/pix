# Historical thinking pruning (experimental)

Module `historical-thinking-prune` in pi-tools-suite. Opt-in via the top-level
suite setting `pruneHistoricalThinking` (default `false`;
`PI_TOOLS_SUITE_PRUNE_HISTORICAL_THINKING=1/0` overrides; Desktop toggle
"Prune historical thinking (experimental)" in Settings → DCP).

## Behavior

- Runs in Pi's `context` event before every model call, so it applies to all
  providers (zai, OpenAI, Gemini, Anthropic, Claude Code, ...).
- Removes `thinking` blocks from assistant messages before the turn boundary:
  the latest `user` message not directly preceded by a `toolResult`. A user
  message after a tool result is a steer inside a running tool loop, so that
  loop keeps its thinking (required by Anthropic for tool continuation).
- Assistant messages left empty are dropped; tool calls, results and text stay.
- Input messages are not mutated; unchanged messages are reused.
- The rule is deterministic, so the history prefix is byte-stable within a turn
  and stays cacheable. Enabling the setting rewrites the cache once.
- Only the model request changes. The session file and Desktop transcript keep
  all thinking; disabling the setting restores full replay.
- Config is read per request (`ensureUserConfig: false`); a read failure logs one
  `config-read-failed` warning and leaves the context unchanged.
- Registered after `dcp`, so DCP accounting sees the full transcript.

## Tests

`external/pi-tools-suite/test/historical-thinking-prune.test.ts`: pruning,
current tool loop kept, steer boundary, prefix stability, no-op cases.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"864ddc617b554fb8c37f9703ebfabfb2594f2c454492ce96446e1573fc2d29ac","checkedAt":"2026-10-30T23:14:53.135Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":51,"reportLanguage":"ru"} -->
