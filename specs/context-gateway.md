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

## Related implementation and tests

- `external/pi-tools-suite/src/context-gateway/index.ts`
- `external/pi-tools-suite/src/context-gateway/enforcement.ts`
- `external/pi-tools-suite/src/context-gateway/storeless-capabilities.ts`
- `external/pi-tools-suite/src/session-recovery/index.ts`
- `external/pi-tools-suite/test/context-gateway/observe.test.ts`
- `external/pi-tools-suite/test/context-gateway/sdk-pipeline.test.ts`
- `external/pi-tools-suite/test/context-gateway/provider-serialization.test.ts`
- `external/pi-tools-suite/test/session-recovery.test.ts`
