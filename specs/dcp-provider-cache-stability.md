# DCP provider-cache stability

## Type

Change / invariant

## Goal

Keep DCP message addressing, reminders, persistence replay, and compression
compatible with append-only provider continuation. An intentional exact history
rewrite may require one rebuilt request; after it, unchanged history must again
be a byte-stable prefix on ordinary continuations.

## Scope

- Stable distributed `mNNN` metadata on deterministic user/tool-result carriers.
- Stable IDs and frozen control text across context passes and journal replay.
- No DCP mutation of assistant messages or provider-signed reasoning/tool-call
  items.
- No routine retroactive pruning merely because a new user turn arrived.
- Exact rewrite boundaries with provider evidence for destructive emergency
  decisions.
- Session-journal persistence without a second provider-tail metadata map.

## Non-goals

- Enabling provider-side `store` mode or changing cache TTL/routing.
- Avoiding the expected cache rebuild caused by an intentional compression or
  explicitly committed prune.
- Proving a server-side cache hit solely from local input equality.
- Supporting pre-journal sessions or old DCP persistence formats.

## Behavior

1. Every addressable raw message receives one monotonic `mNNN` assignment keyed
   by stable session identity. Equal timestamps do not cause renumbering or ID
   reuse; deterministic occurrence identity resolves otherwise identical
   fallbacks.
2. Provider-visible ID metadata is attached only to cloned user, tool-result, or
   bash-result carriers. A carrier publishes its own address and any immediately
   preceding assistant addresses that cannot safely be written into those
   assistant items. Rendering the same committed carrier again produces the same
   bytes.
3. Assistant messages preserve original text, reasoning/signatures, content
   block order, tool-call IDs, and provider item shape.
4. `before_provider_request` records tool results actually present in the
   outgoing payload. HTTP acceptance alone is not completion evidence. Only an
   unambiguously correlated successful finalized assistant response can promote
   the attempt. Provider evidence is transient and returns to unknown on
   restart.
5. A reminder can be introduced only on a fresh trailing user carrier. Once
   published, both its carrier and rendered text are frozen. Later candidate
   counts, IDs, or higher urgency do not rewrite that old item. Without a safe
   carrier, reminder creation is deferred.
6. Ordinary context construction replays already committed pruning but does not
   discover new dedup/error/age deletions at each user-turn boundary. Explicit
   sweep/compression or the bounded emergency route are intentional rewrite
   boundaries.
7. Durable addressing/rewrite decisions are appended as structured
   `dcp-journal` custom entries in the session. Replaying the journal must yield
   the same IDs, summary bytes, active exact blocks, and frozen reminder data
   without a model call.

## Journal contracts relevant to cache stability

- Only journal schema v1 created by the current implementation is supported.
- `init` establishes a new-format session; deltas publish only newly durable
  projection decisions. Identical no-op context passes do not append snapshots.
- Existing `mNNN` assignments are never changed or reused.
- New v2 blocks are exact and immutable in content. Supersession creates/activates
  newer decisions rather than editing summary prose already sent to the provider.
- Provider-seen evidence, request-attempt state, and pressure counters are not
  durable cache authority.
- A pre-journal non-empty session is not silently initialized or restored from a
  side store.

## Invariants

- No DCP transform mutates provider-signed assistant content.
- Re-running the transform over unchanged raw history plus unchanged committed
  journal state yields byte-equivalent provider-visible messages.
- Adding a normal new user/tool tail does not modify an earlier DCP carrier.
- A summary rewrite changes only the exact selected provider-history region and
  required deterministic control representation.
- The first ordinary continuation after an intentional rewrite establishes the
  new prefix; subsequent unchanged continuations preserve it.
- Restart/fork of a supported journal session reuses committed summary and ID
  bytes rather than regenerating them.
- UI filtering is outside this contract: display cleanup cannot alter the next
  provider request.

## Emergency behavior

The newest live group, current request, protected content, recent pairs, and
tool results without completed provider evidence cannot be selected merely to
save cache or context.

When `autoCompress` is explicitly enabled and hard pressure has a safe exact
candidate, DCP prefers a summary rewrite. Positive partial recovery may commit
while retaining remaining recovery debt; it is not rejected solely because one
block cannot satisfy the whole budget. If no safe summary can be committed, the
bounded emergency body-prune floor can remove only eligible provider-seen old
results. Both are intentional history rewrites and must return to stable-prefix
behavior afterward.

If protected/live content itself cannot fit, DCP aborts/hands off rather than
inventing a cache-preserving unsafe deletion.

## Edge cases

- Parallel tool results keep structural grouping and stable tool-call IDs.
- Compression-summary messages remain addressable through active `bN` identity.
- Same-timestamp messages remain distinct through stable branch identity.
- A mid-turn pressure increase cannot synthesize a temporary reminder carrier
  that disappears on the next continuation.
- Restart does not claim old tool results are provider-seen; this may delay an
  emergency deletion but avoids false evidence.
- Fork replay is branch-scoped: journal operations outside the selected ancestry
  do not leak into the forked projection.

## Related files

- `external/pi-tools-suite/src/dcp/journal.ts`
- `external/pi-tools-suite/src/dcp/index.ts`
- `external/pi-tools-suite/src/dcp/pruner-message-ids.ts`
- `external/pi-tools-suite/src/dcp/pruner-nudge.ts`
- `external/pi-tools-suite/src/dcp/pruner.ts`
- `external/pi-tools-suite/src/dcp/conversation-index.ts`
- `external/pi-tools-suite/src/dcp/compress-tool.ts`
- `external/pi-tools-suite/src/dcp/auto-compress.ts`
- `external/pi-tools-suite/test/dcp-journal-lifecycle.test.ts`
- `external/pi-tools-suite/test/dcp-marathon-replay.test.ts`
- `external/pi-tools-suite/test/compress-pruner.test.ts`

## Verification

Deterministic tests must cover:

- stable monotonic ID assignment and journal replay;
- repeated no-op transforms and ordinary append-only continuations;
- exact rewrite followed by at least two stable continuations;
- installed OpenAI Responses conversion preserving the rewritten prefix;
- byte-equivalent signed assistant reasoning/tool-call content;
- frozen reminder carrier/text and deferral when no safe carrier exists;
- restart/fork of a journal session without regenerating summaries;
- hard-pressure marathon behavior and partial positive recovery;
- cancellation/stale owner/source/config/model faults before publication.

The implementation pass reached a green deterministic DCP suite and green
repository/host test gates. A live provider cache/quality canary has **not** been
run and is not implied by those results.

## Risks / unknowns

- Other extensions may independently change an old provider item.
- Provider TTL/routing can miss the cache even for byte-identical inputs.
- The installed SDK has no universal provider request identity, so ambiguous
  interleaving remains fail-closed.
- Session-manager persistence determines crash/power-loss durability of journal
  entries; the DCP journal does not add its own fsync/WAL layer.
- Lossy summary quality still requires task-level/live evaluation; local prefix
  equality proves a cache invariant, not semantic quality.
