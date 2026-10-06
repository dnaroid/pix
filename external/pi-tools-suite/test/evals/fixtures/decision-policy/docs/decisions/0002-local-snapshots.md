# 0002 — Local snapshot durability

- Status: accepted
- Recorded: 2025-02-03
- Owner / approval evidence: product owner accepted offline availability over multi-device freshness
- Governing spec: [Product](../../specs/product.md)
- Replaces / replaced by: none

## Context

Traveling users need existing snapshots when disconnected for weeks.

## Evidence and assumptions

The product owner reported offline usage. No performance measurements were supplied.

## Decision and scope

Persist snapshots locally rather than relying on server-only snapshots. No telemetry-storage decision is covered here.

## Alternatives

Server-only snapshots require connectivity. Local snapshots trade cross-device freshness for offline availability.

## Consequences

Local retention incurs disk usage and accepts stale snapshots across devices.

## Revisit triggers

Revisit if the offline requirement is removed or multi-device consistency becomes mandatory.
