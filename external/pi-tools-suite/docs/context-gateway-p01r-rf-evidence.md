# Context Gateway P01-R / R-F evidence

<!-- markdownlint-disable MD013 -->

> Date: 7 September 2026.
> Repository HEAD during deterministic gate: `daa1b06` with a dirty tested tree.
> Scope: storeless lifecycle and current-result UI/replay only. No new persistent artifact service, native-temp reader endpoint, fork grant, export bundle, DCP lifecycle implementation or manual sync was added.

## Runtime / transient lifecycle

Context Gateway observe state is runtime-local. The current implementation tracks
in-flight tool call IDs separately from aggregate telemetry and refuses an
`off ↔ observe` mode change while any tool call is still in flight. At a safe
boundary the mode change clears transient call bindings. `session_start`,
`session_tree` and `session_shutdown` reset transient and aggregate observation
state.

Deterministic contracts additionally prove:

- a mode change requested during an observed call is rejected until that result
  completes; the result is attributed to the old effective observe epoch once;
- lifecycle reset removes pending bindings and counters rather than carrying them
  into a resumed/switched branch;
- two Read/shell calls may complete in reverse order without crossing tool class,
  parser command-scope or call identity;
- an unbound result increments the explicit `unboundResults` counter but its
  bytes/class/parser facts are not aggregated as current-session evidence;
- extension reload during an in-flight SDK tool remains a separate P00 limitation
  and is not hidden by telemetry; root tab/session generation guards keep a late
  result owned by its origin tab.

No suppression ledger is introduced, and no persisted JSONL message is rewritten
when mode or session lifecycle changes.

## TUI / current result rendering

R-B already proves collapsed/expanded renderer equivalence for the exact
Read/Bash/ast_grep metadata-normalization surfaces, including image preservation.
The root renderer/session gate additionally covers:

- shell running/nonzero/signal rendering;
- LSP diagnostic severity rendering and mutation tool blocks;
- truncated collapsed previews and expanded full current-result bodies;
- persisted history tail/replay, unresolved/completed historical tool calls and
  cancellation while older history is being prepended;
- stale runtime/session event rejection and late tool-result binding to the
  original inactive tab.

These are current/persisted tool-result views; they are not a new route to the
producer's full native temp output.

## ACP / Desktop lazy current-result hydration

Pix already has `pix/session/history`, `pix/session/tool_result` and deferred image
hydration for Desktop. The lazy tool-result route is explicitly scoped by the ACP
`sessionId` and the deferred result map created for that session. For a persisted
result, the backend stores a trusted `sessionPath + byte offset + byte length`
reference and materializes exactly that persisted JSONL message line on demand.

The ACP contract now proves that requesting a deferred result:

- does not replay or append a `session/update`;
- returns the persisted current tool-result content/details only on explicit
  hydration;
- cannot be performed with another session's ID even when the tool call ID is
  known;
- frees the duplicate backend deferred copy after successful hydration.

Desktop transcript logic keeps deferred results lightweight until expansion,
hydrates them into the local transcript, and separately hydrates deferred image
bodies. This is a human/UI operation; it does not create a new model tool result
or provider input.

## Native temp output: deliberate limitation

There is **no existing authenticated host route that reads the contents of a
`Read`/Bash/ast_grep native temp/full-output handle for TUI/ACP/Desktop**.
`pix/session/tool_result` is not such a route: it reads a persisted JSONL result,
not the producer's `fullOutputPath` contents.

Therefore R-F adds no “open full native source” button or ACP endpoint. The UI may
show the current result/status/diagnostics already available through the normal
message path, but P01-R does not widen filesystem access merely because a result
contains a temp path. R-C's lifetime limitations remain in force: temp paths can
be absent, mutable, expired, or unavailable on error/timeout/abort and have no
resume/fork/export guarantee.

## Deterministic gates

Context Gateway lifecycle/result gate:

```text
bun test \
  test/context-gateway/observe.test.ts \
  test/context-gateway/sdk-pipeline.test.ts \
  test/context-gateway/metadata-normalization.test.ts
```

Result: **49 pass, 0 fail, 337 assertions**. Suite typecheck and `git diff --check`
also pass for this gate.

Root TUI/session gate:

```text
node --import tsx --test \
  tests/conversation-tool-renderer.test.ts \
  tests/tool-block-renderer.test.ts \
  tests/conversation-shell-renderer.test.ts \
  tests/session-history.test.ts \
  tests/session-lifecycle-controller.test.ts \
  tests/tabs-controller.test.ts
```

Result: **98 pass, 0 fail**.

ACP lazy current-result gate:

```text
node --import tsx --test \
  --test-name-pattern='desktop lazy session/load omits tool bodies and retrieves them on demand|desktop lazy session/load reuses an already-live tab runtime|deferred' \
  test/agent.test.ts test/session-replay.test.ts
npm run typecheck
```

Result: **4 pass, 0 fail**; ACP typecheck passes. The targeted lazy-result test
also asserts no hydration `session/update` and denial for another session ID.

An additional ACP boundary suite covers persisted lazy materialization and replay:

```text
node --import tsx --test \
  test/session-replay.test.ts \
  test/session-history-file.test.ts \
  test/desktop-commands.test.ts
```

Result: **6 pass, 0 fail**. It additionally proves that the Desktop tool-result
request surface is `sessionId + toolCallId` scoped, ignores arbitrary path-like
extras, legacy persisted metadata is not retroactively normalized during replay,
and deferred image/tool bodies are hydrated only from their existing persisted
session references.

Desktop gate:

```text
npm run check
npm test -- src/lib/transcript.test.ts src/lib/acp-client.test.ts
```

Result: Desktop check has **0 errors** and two pre-existing Svelte accessibility
warnings in `WorkspaceSidebar.svelte`; targeted tests are **28 pass, 0 fail**.

No live model call or manual suite sync was used for R-F.
