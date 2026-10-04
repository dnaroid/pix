# 0041 — Distinguish SDK raw fallback from DCP provider usage

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested fixing the cause of DCP's false
  134% context exhaustion and recovering the affected session if possible.
- Governing spec: [DCP pressure policy](../../specs/dcp.md#pressure-and-autonomous-policy)
- Replaces / replaced by: none

## Context and evidence

Installed SDK 1.0.2 invalidates earlier assistant usage after a `context_edit`.
A network retry omits the failed assistant with such an edit. Its context usage
then estimates the raw SDK projection, which does not include DCP compression.
In the reported session this changed an approximately 71k usage-plus-tail value
to approximately 365k, although durable DCP summaries still projected about 54k
message tokens. DCP treated that estimate as native usage and aborted at a 144k
input capacity. The archive and compression blocks were intact.

The new installed-SDK regression fails before the fix on both error and aborted
retry paths. This is an estimator/projection boundary bug, not lost compression
or subagent token accounting.

## Decision and scope

Reconcile usage inside DCP's context preparation, using the existing validated
full active branch. With no usable assistant sample after the latest edit or
compaction, compute the SDK fallback using public SDK projection/estimation APIs.
Only exact agreement with the observed SDK scalar authorizes rebasing to the
actual DCP messages. Preserve resolved system sections/tool declarations and
fresh hook-message growth. Preserve unknown/mismatched and true measured floors,
the local projection floor, output reservation and hard-capacity abort.

An already-rebased fallback must not receive the separate routine-only
post-compression native-usage adjustment. Compute it afresh per context pass,
including the finished projection; do not persist a new estimator authority.

Resume uses the unchanged archive and normal journal replay; do not delete retry
edits, invent successful usage records, reset compression blocks or clamp the UI
percentage to conceal pressure. Status can still show the SDK raw estimate until
a subsequent successful provider response supplies measured usage.

## Assumptions and limits

The installed SDK does not expose estimator provenance in `getContextUsage()`.
Branch proof plus exact scalar agreement is a conservative compatibility adapter
for its current public behavior, locked against the installed SDK by tests, not
a universal inference for arbitrary hosts. A mismatched future SDK estimator
keeps the existing conservative floor rather than silently lowering usage.

## Alternatives

- Ignore all SDK usage or subtract all saved tokens: could hide genuine measured
  provider overhead or subtract compression twice.
- Patch installed SDK files: not source-owned and lost during install/update;
  would also change hosts that do not run DCP.
- Rewrite the affected session: unnecessary data risk; the journal is healthy.
- Adjust only the percentage display: leaves the false capacity abort unchanged.

## Consequences and revisit triggers

Normal measured requests avoid rebuilding the SDK projection. Fallback requests
perform one extra in-memory canonical projection, using an already loaded full
branch, with no new synchronous disk read. Regression coverage includes lazy
resume, preserved summaries, true native overcapacity and large current tasks.
Revisit when the SDK exposes provenance, changes invalidation/estimation, or
large-session profiling calls for cooperative projection work.
