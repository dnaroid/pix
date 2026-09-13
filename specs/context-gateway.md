# Context Gateway

## Type

As-is.

## Lifecycle

Active implemented contract.

## Goal

Context Gateway controls selected tool-result representations before they are
persisted and reused as provider context. It reduces avoidable context growth
only when the replacement has a deterministic safety/recovery contract; unsafe
or unsupported results remain passthrough.

## Modes

- `off`: no observation or shaping.
- `observe`: aggregate metadata only; tool results are byte-preserving.
- `enforce`: apply the supported result representations below while preserving
  tool outcome, images/usage, and downstream extension ordering.

Runtime mode changes are allowed only at a safe boundary with no observed tool
call in flight. Session lifecycle boundaries reset transient Gateway telemetry.

## Enforce representations

### Test/build output

Recognised, complete, simple Bun/TAP/bounded-TypeScript test/build output may be
replaced with the existing `test-build-compact` representation. Partial,
compound, upstream-truncated, non-text, or unrecognised shell output remains
passthrough.

### Web search/fetch

Over-budget `web_search` and `web_fetch` results may be replaced with
`web-recoverable-compact` only when the producer supplied structured raw details
that are sufficient for later recovery:

- `web_search`: `details.results` retains the complete structured result list.
- `web_fetch`: `details.content` retains the complete extracted content, with
  title/links when supplied by the producer.

The provider-visible compact is bounded by the applicable Context Gateway
inline/result budget and includes useful titles, URLs/previews, and a recovery
key when available. Gateway does not refetch a URL and does not create a second
archive. The original producer details remain attached to the persisted raw
tool result; installed provider serialization does not send tool-result details
to the model.

`session-recovery` is the recovery surface: `session_search` can locate the raw
tool result by `toolCallId`, and `session_read_section` can return or paginate
its `recoverable_raw_details` from the append-only session. If the required
structured details are absent or malformed, Gateway leaves the web result
passthrough instead of applying an irreversible truncation.

## Other result classes

Read results remain producer-owned passthrough. Repo discovery tools retain
their producer-native compact/full-output contracts and are never post-hoc
sliced by Gateway. Structured JSON without a dedicated safe adapter, visual
content, subagent artifacts, and unsupported direct browser/MCP paths keep their
existing class-specific contracts.

## Telemetry and provenance

Gateway records aggregate class/result byte accounting and the selected
delivery representation without storing raw secret-bearing result bodies in its
telemetry state. Persisted compact results include `details.contextGateway` with
version, representation, source content bytes, and delivered content bytes.

When Gateway is active (`observe` or `enforce`), a separate best-effort
accounting stream is enabled by default for longitudinal efficiency analysis. It
writes scalar-only JSONL to `~/.pi/agent/context-gateway-accounting.jsonl`
(override with `PI_CONTEXT_GATEWAY_ACCOUNTING_LOG`) and must never affect a tool
result, provider request, or session outcome when filesystem writes fail.

The accounting stream distinguishes four quantities instead of treating compact
bytes as proven token savings:

- **gross avoided context**: source versus actually delivered result bytes plus
  an explicitly approximate text-token delta. The estimate uses the optional
  installed tokenizer when available and otherwise a cheap character heuristic;
  it is not a billing counter;
- **retrieval tax**: delivered bytes/estimated tokens from recognised follow-up
  retrievals. These include `artifact_read` / `artifact_search`, all
  `session-recovery` read/search/overview/context tools, exact repeated `Read`
  calls, same-source different-range `Read` continuations, and `Read` calls that
  consume a producer-issued artifact handle such as `details.fullOutputPath`.
  Every persisted retrieval `tool.result` carries its own `retrievalBytes` and
  `retrievalEstimatedTokens`; summing those event fields yields the same
  retrieval totals reported by the epoch/session snapshot;
- **conservative net estimate**: gross avoided context minus the complete
  recognised retrieval tax. Retrieval is intentionally charged conservatively;
  not every later retrieval is claimed to have been caused by Gateway;
- **actual provider usage**: finalized assistant `message_end` usage fields
  (`input`, `output`, cache read/write, total tokens and reported total cost),
  together with provider-attempt/completion counts. These are the provider/SDK's
  observed usage, not a counterfactual estimate of a no-Gateway run.

Producer artifact paths are correlated only in transient memory by the same
normalised read-source fingerprint used for repeat-read detection. Raw paths,
tool arguments, result bodies, recovery section IDs/queries, and credentials are
never written to the accounting JSONL. Persisted tool events use local opaque
call references instead of original `toolCallId` values. Transient call and
read-correlation tables are bounded; identities from sufficiently old calls may
age out during an unusually long epoch.

Accounting retention mirrors the DCP debug-log shape: the active file rotates at
approximately 5 MiB by default and keeps three numbered backups (`.1`..`.3`).
Size checks are amortized, so the active file may temporarily exceed the target
by one check interval plus concurrent-process appends. Rotation uses an advisory
cross-process lock; a lock or filesystem failure emits a rate-limited warning,
skips the unsafe operation, and never truncates the active stream as a fallback.
Configure this under `contextGateway.accountingLog` with `enabled`, `maxBytes`,
and `maxBackups`; environment overrides are
`PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED`,
`PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES`, and
`PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS`. Invalid overrides are reported as
configuration issues and ignored. Logging is enabled by default but steady
`off` mode emits no Gateway activity records.

Session start/tree/shutdown boundaries reset in-memory efficiency counters while
the JSONL keeps prior epochs. Each completed epoch emits a scalar session summary
so the retained files can be aggregated without replaying raw Pi session data.
`observe` is the byte-preserving measurement arm: its actual gross savings stay
zero, so the conservative net estimate is meaningful as a savings metric only
for `enforce`; `observe` provider usage/retrieval data is the natural baseline
for comparison runs.

## Related implementation and tests

- `external/pi-tools-suite/src/context-gateway/index.ts`
- `external/pi-tools-suite/src/context-gateway/accounting-log.ts`
- `external/pi-tools-suite/src/context-gateway/efficiency.ts`
- `external/pi-tools-suite/src/context-gateway/enforcement.ts`
- `external/pi-tools-suite/src/context-gateway/storeless-capabilities.ts`
- `external/pi-tools-suite/src/session-recovery/index.ts`
- `external/pi-tools-suite/test/context-gateway/accounting.test.ts`
- `external/pi-tools-suite/test/context-gateway/observe.test.ts`
- `external/pi-tools-suite/test/context-gateway/sdk-pipeline.test.ts`
- `external/pi-tools-suite/test/context-gateway/provider-serialization.test.ts`
- `external/pi-tools-suite/test/session-recovery.test.ts`
