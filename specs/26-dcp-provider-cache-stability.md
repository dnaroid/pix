# Spec: DCP provider-cache stability

## Type

Change

## Goal

Keep DCP message addressing, reminders, and automatic pruning compatible with
append-only provider continuation, especially OpenAI Codex Responses. After an
intentional history rewrite, one full request is acceptable; unchanged history
must become a byte-stable prefix again on the following request.

## Scope

- Replace the moving full-history `<dcp-message-ids>` provider-tail block with
  stable, distributed message-ID metadata on user/tool-result carriers.
- Persist stable-message-to-`mNNN` assignments across context passes and
  session reloads.
- Never add DCP metadata or reminders to assistant messages, because reasoning
  and function-call items may be provider-signed.
- Freeze an anchored reminder's rendered text until its priority is upgraded or
  the anchor is cleared by compression.
- Discover new automatic tool-pruning decisions only at user-turn or
  compression checkpoints; continue applying already-recorded decisions on
  every context pass.
- Preserve provider-exposure tracking for emergency pruning without mutating
  the outgoing provider payload.

## Non-goals

- Enabling provider-side `store` mode or changing provider cache TTLs.
- Eliminating the unavoidable cache miss caused by an actual compression,
  decompression, or already-committed tool-output prune.
- Changing the public `compress` tool schema or `bN` compression-block IDs.

## Behavior

1. Every addressable message receives one persistent `mNNN` assignment keyed
   by its stable session identity. If no durable session ID exists, the fallback
   includes timestamp and canonical content so distinct timestamp collisions
   remain stable when an earlier message disappears. IDs are monotonic and are
   not renumbered when older messages disappear.
2. Provider-visible ID metadata is appended only to context clones of user,
   tool-result, or bash-result carriers. A carrier contains its own ID and IDs
   for immediately preceding assistant messages not covered by an earlier
   carrier. Rendering the same carrier again produces identical text.
3. Assistant messages and their content blocks retain their original text,
   signatures, ordering, and provider item shape.
4. `before_provider_request` may inspect the final payload to track tool-result
   exposure, but returns no replacement payload solely for DCP IDs.
5. A nudge anchored to an existing user message stores the complete rendered
   reminder. Candidate counts or ID snapshots changing later do not rewrite
   that reminder. A higher-priority nudge may replace it once. If no user
   carrier exists, DCP appends a synthetic user reminder instead of modifying
   an assistant message.
6. Deduplication, old-error discovery, and policy auto-pruning run once per new
   user-turn checkpoint and once after creation of a new compression block.
   Known `prunedToolIds` are still rendered as placeholders on every pass.

## Contracts

- `compress` continues accepting raw `mNNN` and active `bN` IDs.
- Sidecar state gains backward-compatible optional fields for persistent
  message-ID assignments, the next message-ID counter, frozen reminder text,
  and automatic-pruning checkpoint counters.
- Legacy sidecars without those fields restore with safe defaults and assign
  stable IDs on their first transformed context.
- Debug output identifies distributed-carrier delivery rather than a moving
  provider-payload map.

## Invariants

- Existing stable identities never change their assigned `mNNN` within a
  session or after sidecar restore.
- No DCP transform mutates provider-signed assistant content.
- Re-running the context transform over unchanged raw history and unchanged DCP
  state yields byte-equivalent provider-visible messages.
- Automatic pruning does not introduce repeated mid-turn retroactive prefix
  rewrites.

## Edge cases

- Parallel tool results may each carry their own ID; the first carrier after an
  assistant response also carries that assistant's ID.
- Compression-summary user messages remain addressable and may also expose the
  corresponding active `bN` marker.
- Distinct same-timestamp messages use canonical content fingerprints. Truly
  byte-identical fallback collisions are resolved deterministically per
  occurrence so two current messages never share one raw ID.
- A legacy nudge anchor without frozen text renders once, stores that rendering,
  and then remains stable.
- Branches whose user-turn count moves backwards reopen an automatic-pruning
  checkpoint instead of suppressing pruning indefinitely.

## Related files

- `external/pi-tools-suite/src/dcp/pruner-message-ids.ts`
- `external/pi-tools-suite/src/dcp/pruner-nudge.ts`
- `external/pi-tools-suite/src/dcp/pruner-tools.ts`
- `external/pi-tools-suite/src/dcp/pruner-metadata.ts`
- `external/pi-tools-suite/src/dcp/pruner.ts`
- `external/pi-tools-suite/src/dcp/state.ts`
- `external/pi-tools-suite/src/dcp/index.ts`
- `external/pi-tools-suite/test/compress-pruner.test.ts`
- `external/pi-tools-suite/test/dcp-state-serialization.test.ts`

## Verification

- Unit-test stable ID assignment and sidecar round-trips.
- Convert consecutive contexts with the SDK's OpenAI Responses converter and
  assert the second input starts with the prior input plus untouched assistant
  response items.
- Assert signed reasoning/tool-call assistant blocks are byte-equivalent after
  repeated context transforms.
- Assert same-priority nudge reapplication is frozen and an upgrade changes it
  once.
- Assert duplicate/auto-prune discovery waits for the next user-turn checkpoint.
- Run `npm --prefix external/pi-tools-suite run check` and root `npm run check`.

## Risks / unknowns

- Any other extension that rewrites old provider payload items can still break
  continuation independently of DCP.
- Intentional DCP history rewrites still incur one provider-cache rebuild.
- Emergency mid-turn compression is such an intentional rewrite. To avoid
  touching the in-flight head, its range candidate excludes the current user
  request and retains the newest assistant group plus the configured recent
  complete tool pairs; a later assistant response is used as evidence that the
  older selected prefix belonged to an already-completed provider transaction.

## Evidence

- Confirmed before this change: DCP rebuilt a full ID map and appended it to the
  latest provider payload item on every request.
- Confirmed by provider implementation: Codex Responses continuation requires
  the new input to begin byte-for-byte with the prior input plus response items.
- Confirmed by session diagnostics: exact retries hit the full cache, while the
  next normally advanced request falls back to the static prompt-only cache.
- Confirmed by tests: current DCP tests cover message IDs, anchored nudges,
  pruning, provider exposure, and state persistence, providing regression
  extension points.
