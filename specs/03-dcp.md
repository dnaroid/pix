# 04 — dcp: dynamic context pruning (as-is spec)

> Risk classes: **data / cross-cutting / provider-context mutation**. DCP is
> headless. The raw Pi session branch remains the recovery source; DCP mutates
> only the projected provider context and its session-private sidecar.

## Purpose

DCP monitors projected context pressure, removes proven redundant/eligible tool
output from the provider projection, exposes the `compress` tool, and can
produce bounded continuation summaries when explicitly enabled. It preserves
provider-signed assistant objects and uses stable `mNNN`/`bN` addressing.

## Current lifecycle

1. `session_start` resets the runtime epoch, cleans only proven orphan sidecars,
   loads a validated sidecar generation, and may inherit fitting compression
   state from `previousSessionFile`. Late loads from a replaced session epoch
   are discarded.
2. `tool_call`/`tool_result` maintain runtime tool records. The persisted cache
   is compact; exact args/output are rehydrated from the raw branch after a
   restart for records still represented in the compact cache.
3. `context` builds the projection, maintains stable IDs, evaluates budget and
   compression candidates, applies existing blocks/prune decisions, and manages
   nudge/progress state.
4. `before_provider_request` records an immutable attempt envelope containing
   session epoch, provider/model, payload revision and the tool results actually
   serialized in that request. It does **not** mark those results completed.
5. `after_provider_response` records HTTP acceptance only. HTTP 2xx is not a
   completion witness because the SDK fires this hook before the response
   stream is consumed.
6. A successful finalized assistant `message_end` may promote provider evidence
   only when the pending attempt can be correlated unambiguously. Abort/error or
   interleaving ambiguity is fail-closed and does not make tool outputs eligible.
7. `agent_end`/`session_shutdown` persist state through the versioned sidecar.

## Canonical identity and projection

`conversation-index.ts` builds the current ordered conversation index from the
actual projected branch. Ordering and tool-group closure use branch index, not
timestamp sorting. Timestamps remain legacy boundary metadata only; equal
timestamps are resolved by stable identity/current `mNNN` order.

Generated DCP provenance is carried out-of-band with non-enumerable internal
properties. Literal `<dcp-system-reminder>`, `[dcp-block-id]`, or similar text in
raw user content never grants synthetic/control-plane authority.

Stable `mNNN` allocation is monotonic and persisted. Assistant content is never
used as a DCP carrier. Distributed ID metadata is attached to client-originated
user/tool-result/bash-result clones; repeating an unchanged transform preserves
already-published provider items.

## Compression blocks

### Version 2 writer semantics

New blocks use `version: 2` and one of two exact replacement modes:

- `range`: replace exactly the preflighted closed range with one synthetic
  summary message. The apply path does not widen the range around tool groups.
- `message-body`: replace only the selected tool-result/body content while
  preserving role, call id, tool name, error status, position, and sibling
  results. Signed assistant content is not editable by message mode.

Manual range preflight rejects a selection that cuts a parallel/in-flight tool
group and reports the protocol-safe boundaries. Auto range planning closes the
range before summarization. New v2 plans do not rely on orphan repair;
`repairOrphanedToolPairs` remains only for legacy block compatibility.

Multiple operations in one `compress` invocation are staged on a working state.
Fatal preflight/prepare/persistence failures publish none of the staged blocks.
Retries with the same compress tool-call id are idempotent.

Legacy blocks without `version: 2` retain their historical projection semantics
for backward compatibility and are not silently reinterpreted as v2 blocks.

## Pressure, progress and autonomous policy

The E05 controller separates provider-native usage from the fresh repository
projection. Effective pressure uses the larger value, so a stale low provider
usage sample cannot hide a large paste or newly appended tool output.

Capacity is distinct from policy thresholds: output/tool reserve is removed
first, `summaryBuffer` is bounded by remaining capacity, and hard emergency is
not disabled by a model-specific soft threshold. Auto planning chooses the
oldest protocol-safe prefix needed for the current recovery target; if the full
target cannot be met it may expose the largest safe partial candidate rather
than pretending no safe material exists.

`patience` advances only on completed correlated main-provider opportunities in
which the reminder was available. Repeated `context` transforms and identical
request retries do not consume patience.

Terminal blocked reasons include `live-head-only`,
`protected-budget-exceeded`, `evidence-unknown`, `summarizer-unavailable`,
`non-positive-gain`, `missing-source`, and `budget-exhausted`. If the protected
minimum itself exceeds hard capacity and no safe shrink exists, DCP records the
recovery state and uses the SDK headless `ctx.abort()` path rather than sending
the same oversized request indefinitely or invoking destructive native
compaction implicitly.

`compress.autoCompress.enabled` is **false by default**. Manual mode cannot be
widened into autonomous summary creation. Disabling routine `autoCandidates`
does not silently disable the separately configured emergency safety planner.

## Provider evidence and emergency eligibility

Tool-result deletion/range compression requires completed provider evidence.
A later assistant message is structural ordering evidence only; it is not proof
that every preceding tool result was serialized and consumed. Emergency range
planning and emergency body pruning use the same completed-evidence set and
fail closed on unknown/incomplete groups.

The newest assistant/tool group, current user request, configured recent tool
pairs, protected tools/files/tags, and unseen results remain outside emergency
mutation. An intentional emergency compression or prune is a provider-history
rewrite; ordinary continuations after that transition must again be byte-stable.

## Summary source and fallback

Auto summary preparation builds a bounded source manifest. Tool entries include
call id, tool name, necessary non-secret arguments/path, result linkage,
outcome, error state and exit code when available. Credential/header-like
fields and provider signatures are excluded/redacted.

Configured summarizer models share one total deadline that includes auth,
fallback models and completions that ignore `AbortSignal`. Oversized sources are
chunked only on complete tool-group boundaries and merged with explicit source
coverage; a single group that cannot fit is refused rather than silently split.

Fallback order is model summary → bounded extractive continuation record →
refusal when the replacement cannot meet the positive/full-budget gain gate.
The extractive record keeps explicit user constraints, decisions/checkpoints,
errors/verification failures, next steps and tool metadata; large successful raw
logs are not copied wholesale. New blocks store source hash/coverage,
representation mode and a deduplicated protected-fragment ledger so repeated
rollups do not recursively embed old summaries.

## Protected data and recovery

Protected user/tag/tool fragments are copied deterministically into the block
ledger. Subagent `result.md` is optional recovery material, not the primary
source. Artifact reads are asynchronous, bounded, rooted at the session
`ctx.cwd`, resolved through `realpath`, restricted to regular files, and reject
symlinks escaping the session cwd. An oversized protected artifact blocks the
operation instead of being silently truncated.

`/dcp decompress` for a modern v2 block requires both exact raw source boundary
identities still present in the active branch. If host compaction or user
history deletion removed them, the command reports unavailable source and
leaves the block active; DCP does not guess boundaries or re-run mutating tools.
Legacy blocks retain legacy decompression compatibility.

## Tool-output pruning policy

Exact dedup requires the same input fingerprint **and** the same output identity
(SHA-256 text identity plus success/error semantics). Re-running the same read
after a file/environment change therefore is not an exact duplicate.

Autonomous generic output pruning is restricted to known/configured read-like
tools. Mutating aliases are normalized case-insensitively and protected,
including `write`, `edit`, `apply_patch`, `patch`, `bash`, `shell`,
`powershell`, `exec`, and `execute`; unknown tools are not assumed safe for
autonomous deletion.

## Configuration

DCP config is read only from `dcp` in
`~/.config/pi/pi-tools-suite.jsonc`; legacy standalone/project DCP config is
ignored. Important defaults are:

- `enabled: true`, `manualMode.enabled: false`,
  `manualMode.automaticStrategies: true`;
- `compress.minContextPercent: 0.40`, `maxContextPercent: 0.65`,
  `summaryBuffer: true`;
- `compress.autoCandidates.enabled: true`;
- `compress.messageMode.enabled: true`;
- `compress.autoCompress: { enabled: false, patience: 2,
  summarizerModel: [], timeoutMs: 20000 }`;
- `strategies.emergencyCurrentTurnPruning.enabled: true`, hard/target defaults
  remain defined in `config.ts`;
- per-model limits/overrides support exact keys and `*`/`?` patterns.

No new user-facing E05/E06 knobs were added by the reliability implementation;
budget margins, source-manifest caps and artifact caps are internal safety
limits.

## Persisted state

The sidecar path remains
`<sessionDir>/dcp-state/<sanitizedSessionId>.json`, but new writes are a
versioned envelope:

```text
{ kind, schemaVersion, sessionId, generation, revision, payloadHash, payload }
```

The payload is validated before restore: bounded sizes, compression-block ids,
boundaries, references and acyclic block graph. Legacy flat
`SerializedDcpState` files are accepted through a migration adapter.

Writes serialize immutable bytes before queueing, use private `0600` temp files,
file/directory sync where supported, atomic rename, and a per-sidecar
cross-process exclusive lock. A concurrent writer receives an explicit conflict
instead of silent last-writer-wins. The previous valid generation is retained
as `.prev`; corrupt primaries are quarantined and recovery tries `.prev`.
Unrecoverable corrupt state blocks a subsequent empty overwrite.

Cleanup deletes only proven orphan primary sidecars after a complete session
ownership scan. A malformed/transient session header makes cleanup fail closed.
A live paused session is retained regardless of sidecar age.

Compact tool records still omit large output/full args. On context rebuild,
records retained in the compact cache can rehydrate exact args/output from the
raw session branch; trimmed unknown IDs are not reconstructed as evidence.
Lifetime tool-call count remains monotonic across serialize/restore cycles.

## Cache stability invariants

- Provider-signed assistant bytes are unchanged by DCP.
- One intentional rewrite may rebuild provider cache; the next ordinary
  continuations must preserve the rewritten prefix.
- The installed OpenAI Responses converter is covered by a regression that
  checks two successive continuations after a v2 rewrite.
- Frozen nudge carriers do not churn because candidate IDs/counts changed.
- Debug-disabled state snapshots return before scanning the state.

## Current limitations / release hold

- `autoCompress.enabled` remains false by default. Deterministic correctness,
  replay, seeded generative and local performance gates are not a substitute
  for production continuation-quality evaluation.
- No live model/provider canary was executed for this implementation pass.
- Cross-process locking is fail-closed; a stale lock left by a killed writer
  requires operational cleanup rather than unsafe lock stealing.
- Provider completion evidence is only as strong as the installed SDK lifecycle
  and unambiguous local correlation. With no request id, ambiguous interleaving
  is deliberately `evidence-unknown`.
- Native host compaction that removes modern raw source boundaries makes exact
  decompression unavailable; the block stays active rather than guessing.

## Verification

Deterministic coverage includes focused DCP suites, a 1000-tool-group one-user
replay with 10 rollups + restart + fork, seeded independent-reference
conversation-index properties, real SDK Responses conversion, persistence fault
fixtures and an in-repo performance benchmark (`scripts/dcp-benchmark.ts`). See
`specs/27-dcp-reliability-evidence.md` for the measured gate snapshot and
remaining rollout work.
