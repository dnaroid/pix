# Historical thinking pruning (experimental)

Module `historical-thinking-prune` in pi-tools-suite. Opt-in via the top-level
suite setting `pruneHistoricalThinking` (default `false`;
`PI_TOOLS_SUITE_PRUNE_HISTORICAL_THINKING=1/0` overrides; Desktop toggle
"Prune historical thinking (experimental)" in Settings → DCP).

## Behavior

- Runs in Pi's `context` event before every model call, so it applies to all
  providers (zai, OpenAI, Gemini, Anthropic, ...). Claude Code is the exception:
  its serializer omits historical thinking unless
  `PI_CLAUDE_CODE_PROVIDER_REPLAY_THINKING` enables replay, so this setting
  changes its requests only in that case (see
  [Claude Code provider](../providers/claude-code-provider.md)).
- Removes `thinking` blocks from assistant messages before the turn boundary:
  the start of the latest consecutive `user` group not directly preceded by a
  `toolResult`. An entire group after a tool result is treated as steering inside
  a running tool loop, so multiple queued steers keep that loop's thinking.
- Assistant messages left empty are dropped; tool calls, results and text stay.
- Input messages are not mutated; unchanged messages are reused.
- The rule is deterministic for an unchanged history prefix within a turn.
  Pruning at later turn boundaries can change the prefix again; cross-turn cache
  hits and WebSocket continuation are not guaranteed.
- Only the model request changes. The session file and Desktop transcript keep
  all thinking; disabling the setting restores full replay.
- Config is read per request (`ensureUserConfig: false`); a read failure logs one
  `config-read-failed` warning and leaves the context unchanged.
- Registered after `dcp`, so DCP accounting sees the full transcript.

## Regression coverage

Coverage includes pruning, preservation of signed active thinking through batches
of steers, a real new turn after the loop finishes, missing-boundary no-op cases,
prefix stability and input immutability.

## Experimental limitations

The filter still removes entire historical thinking blocks for every provider,
including signatures or encrypted reasoning stored on those blocks. The steering
fix does not establish provider-contract compatibility or measured cost savings.
Provider-aware preservation is not implemented yet. Disabling the setting
restores full replay; the steering fix itself does not change configuration.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"864ddc617b554fb8c37f9703ebfabfb2594f2c454492ce96446e1573fc2d29ac","checkedAt":"2026-10-30T23:14:53.135Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":51,"reportLanguage":"ru"} -->
