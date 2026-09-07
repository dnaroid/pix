# Context Gateway P00 ADR: tool-result stage ordering

<!-- markdownlint-disable MD013 -->

> Status: accepted implementation decision for future Context Gateway work.
> This ADR does not enable Gateway, change user configuration, or certify rollout.
> Evidence baseline: repository `daa1b06`, installed Pi SDK `0.85.1`, 7 September 2026.

## Context

The installed extension runner chains `tool_result` handlers in registration
order. The suite currently has four independent `tool_result` registrations:
LSP, comment-checker, DCP, and the opt-in credential firewall. Their module load
order is LSP → comment-checker → DCP → credential firewall.

That order is unsuitable for Gateway enforce mode:

- mutation diagnostics must be present before Gateway renders a bounded result;
- session-hygiene redaction, when enabled, must happen before durable capture;
- Gateway must shape before DCP records the delivered result;
- changing the global `MODULES` order would also change unrelated lifecycle and
  provider hooks, including the intentionally late provider firewall.

P00 tests also prove that throwing from a result handler is fail-open, and that
an in-flight extension tool can cross an extension reload: the old wrapper then
fails on its stale runner while the new runner handles the resulting error.
Therefore current active-runner state is not an origin binding.

## Decision

For the current **P01-R storeless scope**, keep the existing independent
`tool_result` chain. A suite-local coordinator is **not** introduced merely to
make the architecture look uniform. It becomes conditional future work only if
a store-backed/enforce stage is authorised and a concrete conflict between
enabled suite-owned result handlers cannot be expressed safely through the
verified event-specific order.

The verified storeless order is:

1. LSP and comment-checker result enrichers.
2. Context Gateway `observe` (passive; no result patch).
3. Optional `truncation-metadata-normalizer` (details-only duplicate cleanup).
4. Other downstream result observers/modifiers; the current legacy DCP happens
   to be in this position but P01-R does not depend on DCP state or persistence.
5. Opt-in credential-firewall session-hygiene redaction.

For provider hooks, credential-firewall redaction runs before
`codex-reasoning-fix`, and `codex-reasoning-fix` remains the final
`before_provider_request` sanitizer.

This order is covered both by the `MODULES` contract and by an executable
`ExtensionRunner` chain with a DCP-free fake downstream observer. The optional
normalizer removes only redundant metadata; the later firewall still owns secret
redaction. With firewall session hygiene disabled, the normalizer does not redact
or otherwise alter visible content.

If a future enforce/store stage is authorised, the previously proposed
coordinator remains the candidate design: modules participating in it must not
also register an independent `tool_result` handler, while their non-result hooks
remain registered normally. That future decision must be revalidated against the
then-current DCP/session-recovery implementation rather than copied mechanically
from the legacy chain.

The **future enforce coordinator candidate** order is:

1. **Enrich** — LSP mutation diagnostics, then comment-checker output.
2. **Session-hygiene sanitize** — the credential-firewall tool-result transform
   when that existing opt-in policy is enabled.
3. **Gateway sanitize/capture/render** — apply Gateway's archive-specific
   permitted-snapshot sanitizer, consume any trusted pre-truncation capture
   handle, publish if policy requires it, and return passthrough/exact/compact/
   degraded delivery.
4. **DCP observe** — record only the result that will be delivered after the
   preceding stages.

The credential firewall's `before_provider_request` hook stays in its existing
late provider position. `codex-reasoning-fix` remains the last provider-payload
sanitizer. The coordinator is event-specific; it is not a replacement for
global module ordering.

### P01-R storeless ordering before any coordinator exists

The accepted coordinator above is conditional future **store-backed enforce**
work. P01-R does not add it merely to clean redundant SDK metadata. The checked
storeless path keeps independent handlers and the current suite registration
order:

1. suite-owned result enrichers such as LSP/comment-checker;
2. Context Gateway `observe`, which records the original result boundary and
   does not transform it;
3. optional `truncation-metadata-normalizer`, which may remove only a proven
   duplicate `details.truncation.content` while preserving the delivered body,
   outcome and every other details field;
4. downstream result observers. The R-B contract uses a fake observer with no
   DCP imports so this boundary is not coupled to the current or future DCP
   implementation;
5. optional credential-firewall `tool_result` hygiene, which remains the
   security transform for delivered result content/details when that module is
   enabled;
6. provider hooks later run in their normal order: credential firewall before
   the final `codex-reasoning-fix` payload sanitizer.

This ordering intentionally lets `observe` measure the pre-cleanup metadata
boundary. The normalizer is not a security boundary and does not restore or
create source bytes. If firewall hygiene is enabled after it, secrets still
present in delivered content/remaining details are redacted before JSONL/next
provider context. When hygiene is disabled, the normalizer must not silently
pretend those bytes were redacted.

The normalizer's tool-name/SDK-shape allowlist is a compatibility guard, not
trusted provenance. `tool_result` carries no authenticated extension owner, so
a replacement tool can reuse `Read`/shell/`ast_grep` names. Exact duplicate
cleanup can remain semantics-preserving while all stronger capability/lifetime
claims for such a replacement stay **limited**. A future capture/store path
cannot use this name/shape test as permission to open a path or publish a
snapshot.

R-B does **not** introduce a coordinator because no conflict requiring one is
present in the storeless path. Existing tests prove independent handler
composition, exception fail-open behavior and the fact that a later extension
can reinsert raw content. Therefore hard enforce remains unsupported; if a
future store-backed stage needs different security ordering, it must implement
the event-specific coordinator without leaving duplicate independent result
registrations active.

## P01-R same-name replacement limitation

The metadata normalizer can conservatively reject unknown tool names and
malformed/non-matching truncation metadata, but the generic `tool_result` event
does not carry a cryptographic or host-owned identity proving which tool
definition produced a result. A separately loaded replacement that deliberately
uses a measured name such as `read` plus the exact SDK truncation shape is
therefore **not independently provenance-certified** by name+shape alone. P01-R
support claims are limited to the verified suite/SDK tool combinations. Strict
enforce must not generalise this heuristic to arbitrary replacements without a
host-owned tool-definition identity seam.

## Failure contract

Gateway stage failure must not rely on `throw`. A Gateway failure returns an
explicit bounded degraded result that preserves the real execution outcome and
states that archival/retrieval is unavailable. A successful mutation must never
be reported as "not executed" merely because publication failed.

Enrichment or optional session-hygiene failures keep their existing semantics
until their coordinator adapters are implemented and tested. DCP observation
must never be allowed to restore a raw source after Gateway shaping.

## Origin binding and reload

`toolCallId` is necessary but not sufficient. Gateway execution identity must
also bind the originating session/workspace and attempt/runtime epoch before an
await boundary. The active tab or current extension runner after execution is
not authoritative.

The installed SDK currently makes extension reload during an in-flight custom
tool a limited path: `wrapRegisteredTool()` touches the old runner after the
tool returns and can turn the original completion into a stale-runner error.
Gateway strict-enforce support for such cross-reload executions is therefore
**not claimed**. Wrapper-level capture may preserve permitted bytes as an
orphaned source, but it must not fabricate a successful delivered result.

At the app layer, tab ownership already uses runtime/session/generation guards.
Gateway bindings should use equivalent host-owned identity rather than the
currently active tab.

## Capture implications

- Built-in `read`: generic `tool_result` is after truncation and there is no
  full-output handle. Treat as limited unless a supported execution wrapper is
  introduced; exact native paging remains the primary path.
- Built-in `bash`: generic result is bounded, but a trusted `fullOutputPath`
  exists on successful truncated output. Timeout/abort throw paths preserve a
  text prefix/status but lose structured details.
- `repo_*`: add any future capture seam inside the suite wrapper before
  `truncateOutput`; the generic result hook cannot recover omitted bytes.
- `ast_grep`: the suite wrapper can capture before truncation and already
  exposes a full-output temp path when truncated.
- Unknown/custom tools remain limited unless their concrete execution path is
  separately proven.

## Unsupported integrations in the current evidence

The current Pix ACP `session/new` implementation consumes `cwd` and `_meta` and
does not plumb the protocol `mcpServers` field into a local MCP execution path.
MCP result capture is therefore unsupported, not implicitly covered by the
generic hook.

Browser QA runs in a child Pi process launched with `--no-extensions` plus a
restricted extension set. The parent Gateway cannot observe Playwright DOM,
network, or console bytes as parent `tool_result` events. Future integration may
reuse completed subagent artifacts; it is not a direct browser adapter.

## Storage/platform boundary

P00 chooses no durable publication primitive. Current tests run on macOS and do
not certify directory rename/fsync/no-clobber or cross-process quota behavior on
Linux or Windows. Until P02 fault/platform tests exist, Gateway must not describe
its storage as crash-durable across the supported platform matrix.

## Third-party extensions

The suite coordinator controls only suite-owned stages. A separately loaded
third-party extension may register a later `tool_result` modifier and reinsert
large/raw data. Strict enforce is unsupported for an unverified extension
combination until a final session/provider-boundary test proves that the raw
sentinel cannot reappear.

## Evidence

- `test/context-gateway/sdk-pipeline.test.ts`
- `test/context-gateway/capture-contracts.test.ts`
- `test/context-gateway/lifecycle-contracts.test.ts`
- `test/context-gateway/provider-serialization.test.ts`
- `test/context-gateway/p00-capabilities.md`
- root `tests/tabs-controller.test.ts`, late origin-tab result contract
