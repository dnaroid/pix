# 04 — dcp: dynamic context pruning (as-is spec)

> Risk classes: **data / cross-cutting / provider-context mutation**. DCP is
> headless. Raw Pi session messages remain the recovery source; DCP changes only
> the projected provider context and persists durable projection decisions as
> structured `dcp-journal` custom entries in the same session JSONL.

## Purpose

DCP keeps a long-running agent inside its context budget without rewriting the
raw conversation. It exposes stable `mNNN`/`bN` addressing and the `compress`
tool, can apply exact continuation summaries, and has a bounded emergency path.
Historical details are recovered through `session-recovery`, not by expanding a
compressed block back into the provider prefix.

Only sessions created by the journal implementation are supported. There is no
sidecar importer, legacy state reader, dual-write mode, `decompress`, or
`recompress` compatibility path.

## Lifecycle and persistence

1. A confirmed new persistent session receives one `dcp-journal` `init` custom
   entry before DCP publishes provider-visible addressing/rewrite decisions.
   Ephemeral sessions use the same contract in memory for their lifetime.
2. `session_start` resets transient runtime state and replays the complete
   journal on the active branch. A non-empty persisted session without a valid
   journal is deliberately unsupported rather than adopted as a new DCP
   session. Unknown versions, broken predecessor chains, or conflicting
   operation IDs fail closed.
3. `tool_call`/`tool_result` maintain transient tool records. Exact args/output
   needed by current policy can be reconstructed from the raw branch. Large raw
   tool bodies are not duplicated into the journal.
4. `context` builds a detached provider projection, applies already committed
   exact blocks/prune decisions, maintains stable IDs, evaluates pressure and
   candidates, and publishes any new durable projection decision before the
   resulting bytes may be used by the provider.
5. `before_provider_request` records which tool results actually occur in the
   outgoing payload. `after_provider_response` treats HTTP status as diagnostic
   acceptance only. A successful finalized assistant `message_end` can promote
   provider evidence when the local attempt is unambiguous. This evidence is
   runtime-only and returns to unknown after restart.
6. `agent_end` and `session_shutdown` do not persist a full DCP runtime snapshot.
   Durable decisions are appended at their mutation/publication boundary.

Plain `custom` entries are not provider messages. `dcp-journal` must never be
stored as `custom_message` or copied into a model-facing tool result.

## Journal contract

The only supported durable format is `dcp-journal`, schema version 1. Operations
form an append-only predecessor chain beginning with `init`; later `delta`
records contain only changes required to reproduce the provider projection:

- newly allocated stable-message → `mNNN` assignments and the high-water mark;
- new exact v2 compression blocks and their active/superseded state;
- explicitly committed pruned tool-result IDs and reasons;
- the session-local manual-mode value when changed;
- frozen nudge anchor data required to reproduce already published control text.

Every modern compression block has `version: 2`, an explicit replacement mode,
ordered `sourceMembers` and `mutationMembers`, and canonical content hashes. New
blocks are immutable except for derived active/deactivation state. Reusing an
operation ID with identical bytes is idempotent; reusing it with different data
is a conflict.

The journal intentionally excludes full raw history, provider payloads, complete
tool records, provider-seen evidence, pressure counters, and periodic snapshots.
No-op context transforms do not grow it.

Publication uses the host session append boundary. DCP validates and prepares a
detached state, revalidates owner/source/config/model, appends the operation, and
only then installs the committed projection in live state. The current host
contract does not claim stronger power-loss durability than the session manager
itself; DCP does not add a second WAL, file lock, or `fsync` persistence engine.

## Canonical identity and exact replacement

`conversation-index.ts` builds ordered identity from the actual current
projection. Stable session entry identity wins over timestamps; equal timestamps
are disambiguated by branch order and stable IDs. A modern exact operation is
never widened by guessing a same-timestamp neighbour.

`sourceMembers` describe exactly what the summarizer inspected.
`mutationMembers` describe exactly which canonical raw messages a later replay
is allowed to replace. They remain distinct because prior pruning or an earlier
summary can make the two representations differ.

Range compression must cover a protocol-closed assistant/tool-result group.
Message-body compression can replace one supported tool-result body while
preserving its role, call ID, tool name, error status, position, and siblings.
Signed assistant content is never edited in place.

Manual `compress` batches are staged atomically. Missing exact membership,
overlap, stale source, owner/config/model changes, cancellation, non-positive
full-projection gain, or failed durable publication leave the live operation
uncommitted. A retry with the same tool-call ID and parameters is idempotent;
changed parameters are a conflict.

## Provider-cache stability

DCP treats prefix stability as a correctness constraint:

- assistant bytes, signatures, reasoning/tool-call ordering, and provider item
  shape are preserved;
- `mNNN` assignments are monotonic and never renumbered after rollup/restart;
- ID metadata is distributed over deterministic user/tool-result carriers and
  is not rebuilt as a moving payload-tail map;
- a reminder is introduced only on a fresh trailing user carrier. Once
  published, its carrier and rendered bytes are frozen; stronger later pressure
  does not rewrite it. If there is no cache-safe carrier, reminder creation is
  deferred rather than synthesizing a disappearing tail message;
- a normal new user/tool append does not itself authorize retroactive
  dedup/error/age pruning of old provider items;
- one intentional compression/prune rewrite can rebuild the cache, but ordinary
  continuations after it must again keep the rewritten input as a stable prefix.

The installed OpenAI Responses conversion is covered by tests that compare
successive continuation inputs after an intentional exact rewrite. Actual
server-side cache hits still depend on provider routing/TTL and are not promised
by DCP.

## Pressure and autonomous policy

Effective pressure is the maximum of fresh repository projection and usable
provider-native usage, so a stale low provider sample cannot hide newly appended
content. Capacity reserves provider output space before applying policy
thresholds; hard-capacity pressure is distinct from the routine soft threshold.

Routine context construction only replays already committed pruning decisions.
It does not discover new retroactive dedup/error/age deletions at each user
turn. `/dcp sweep` is an explicit rewrite boundary.

`compress.autoCompress.enabled` remains **false by default**. When explicitly
enabled, an exact safe summary rewrite is preferred under hard pressure. It may
commit positive partial recovery and retain the remaining recovery debt for a
later block; one summary is not required to satisfy the entire accumulated
target. This avoids falling directly from a useful partial candidate to mass
tool-output deletion.

The emergency path protects the current user request, newest live assistant
group, configured recent pairs, protected tools/files, and results without
completed provider evidence. If a safe exact summary cannot be prepared and the
hard safety floor must prune eligible old result bodies, those decisions are
explicitly committed and replayed. If the remaining protected minimum itself
cannot fit, DCP records a blocked state and uses the headless abort/handoff path
instead of sending the same oversized request indefinitely.

Manual mode never enables autonomous summary creation. Failed/ambiguous provider
completion does not count as evidence that a result was seen.

## Summary quality and protected data

Auto summary preparation uses a bounded source manifest containing visible
continuation-relevant text and non-secret tool metadata. Credential/header-like
fields and provider signatures are excluded/redacted. Tool groups are not split
merely to fit the summarizer input budget.

Configured summarizer models share a bounded deadline and fall back to the
deterministic extractive continuity representation. A replacement with
non-positive gain is rejected. Protected user/tag/tool fragments and bounded
subagent artifacts are carried through a deduplicated ledger so repeated
rollups do not recursively duplicate them.

The archive is a safety net, not permission to write weak summaries: active
requirements, decisions, constraints, verification failures, and unresolved
work must remain usable in the working context.

## Recovery instead of decompression

Raw session history remains unchanged by DCP. `session-recovery` can navigate it
with bounded overview/search pages, read a known raw `entry_id` directly, and
continue long entry bodies using opaque cursors. DCP control custom entries are
excluded from archive output.

Recovery returns historical material as a **new tool result**. It never toggles
an old compression block, reinserts raw messages into their former provider
positions, or re-runs mutation tools. If the original source was truncated or
removed by another subsystem, DCP does not claim those unavailable bytes can be
recovered.

## Display filtering

The UI removes recognized DCP control blocks only from the display copy.
Provider/session bytes are untouched. Literal marker examples inside fenced code
or block quotes remain visible. An incomplete/ambiguous control block fails open
instead of hiding the remainder of the assistant answer.

## Configuration

DCP reads its supported configuration from `dcp` in the canonical
`pi-tools-suite.jsonc` configuration. Important defaults include:

- `enabled: true`, manual mode off;
- `compress.minContextPercent: 0.40`, `maxContextPercent: 0.65`;
- routine candidate/message suggestions enabled;
- `compress.autoCompress.enabled: false`, patience 2, no configured summarizer
  model by default;
- bounded emergency-current-turn protection enabled with its limits in
  `config.ts`;
- exact/wildcard model overrides where defined by the current schema.

There is no persistence-backend selector, sidecar path, legacy state format, or
undo configuration.

## Current limitations / release state

- Old/pre-journal sessions are unsupported by design; create a new session to
  use this DCP format.
- Provider exposure is runtime evidence. After restart an older result is
  treated conservatively as unseen until a new completed request proves it.
- Native compaction or external deletion can make raw archive material
  unavailable; journal replay never guesses replacement members.
- Host session persistence does not promise power-loss durability beyond the
  underlying session manager.
- `autoCompress.enabled` remains opt-in.
- No live provider quality/cache canary is claimed by this implementation pass.

## Verification

Deterministic coverage includes journal validation/replay, new-session
restart/fork without sidecars, exact membership and stale-owner faults, signed
assistant/provider-prefix invariants, direct paged recovery, UI marker examples,
and long one-user-turn marathons. The current implementation gate also exercises
the installed OpenAI Responses converter and repeated rollups while preserving
continuation-critical facts.

Live provider cache hit-rate/quality remains a separate canary gate and must not
be inferred from local serializer-prefix equality alone.
