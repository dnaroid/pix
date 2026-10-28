# 0070 — Source-isolated search indexes and bounded uncertain recovery

- Status: accepted
- Recorded: 2026-10-11
- Decided: 2026-10-11
- Owner / approval evidence: user request for six isolated search indexes; explicit
  answer to `uncertain-paid-work` selected automatic recovery after a delay, with
  bounded retries and possible duplicate billing (conversation entry `b2025f1e`,
  2026-10-11 17:13 UTC). This approves the recovery trade-off, not production readiness.
- Governing specs: [native search](../search/native-repository-search.md),
  [universal search](../search/desktop-universal-search.md),
  [index status](../search/desktop-search-index-status.md)
- Replaces / replaced by: none. This changes the shared-storage implementation
  described historically in [0066](0066-native-repository-semantic-search.md),
  not its provider/privacy contract or [0068](0068-global-semantic-configuration.md).

## Context

Settings and Tasks shared a SQLite writer while awaiting provider HTTP. A local
60-second writer-acquisition workaround did not remove the architectural cause.
The user required six source databases, short transactions, compatible-vector
migration, unchanged canonical data and one global embedding configuration.

## Observations and sources

- `external/pi-tools-suite/src/project-search/source-work.mjs` and its tested ACP
  twin implement durable source ownership and shared provider slots.
- `external/pi-tools-suite/test/source-work.test.mjs` exercises independent
  processes, terminated workers in a live process, heartbeat expiry, cancellation,
  migration interruption and retained originals using fixtures, not paid providers.
- A process crash can leave a provider request accepted remotely but no locally
  recorded result. Local leases cannot establish whether it was billed or stopped.
  This uncertainty was explained before the user's recovery choice above.
- Real provider behavior and real Desktop recovery were not verified in this task.

## Decision

The governing specifications are [native repository search](../search/native-repository-search.md),
[Desktop universal search](../search/desktop-universal-search.md), and
[Desktop search index status](../search/desktop-search-index-status.md). The suite
[README](../tools/suite.md) also summarizes the recovery contract.

Use one database per source and a separate global SQLite coordinator, not a
transaction held during HTTP. Source claims and provider slots use 90-second
renewable leases. Expired leases can be reclaimed regardless of whether the PID
still exists: a terminated worker can share a live parent PID. Publication must
validate ownership plus current content/model before a short commit.

Source and provider leases renew every 30 seconds and expire after 90 seconds. Normal
cancellation retains both claims and slots until the tracked transport actually settles;
lost ownership cannot be resurrected or used to publish. A queued source keeps its claim
renewed and rechecks ownership after acquiring a provider slot. After two failed or
interrupted network attempts (initial attempt plus one automatic retry), require explicit
Continue; a successful request resets the failure count, and Continue clears an exhausted
budget before reconciliation. Status polling cannot initiate recovery. Coordinate at most
four valid provider leases across participating processes and projects; this is not a
provable remote execution limit after crash or partition.

## Alternatives

- **Only explicit Continue after any uncertain request:** offered to the user;
  not selected. It reduces automatic repeat billing but needs intervention after
  the first crash.
- **Keep a slot whenever its PID is alive:** does not recover a terminated worker
  thread inside a live ACP/Desktop process. A renewable lease is required instead.
- **Only increase SQLite writer timeouts:** the existing workaround; rejected by
  the user's request because it retains cross-source contention and long writes.

## Consequences

Independent sources can progress while another awaits the network. A healthy
source owner deduplicates document work, and migration retains original databases.
All participating clients must be restarted on the new protocol; old writers do
not obey the coordinator or update the new indexes.

Automatic uncertain recovery can repeat remote billing. After a crash, long
event-loop stall or lease loss, a remotely running request can overlap a new one:
four valid local leases are not a proof of a four-request remote execution limit.
Late local results are fenced rather than published. A noncooperative transport
can delay teardown while its ownership is retained.

## Revisit when

Provider idempotency/status APIs can resolve uncertain requests; duplicate billing
or lease expiry becomes operationally significant; noncooperative teardown is
observed in production; or clients need different global fairness/concurrency rules.

## Scope amendment — 2026-10-11

After the original source-isolation decision, the user explicitly rejected legacy
support and authorized deletion of legacy databases in this project only. The
migration observations above describe the original scope, not current behavior:
legacy import/migration code and migration tests have been removed. Only the six
source-local stores are supported; schema-1 Settings caches fail without mutation.
The source/provider ownership and uncertain-billing recovery decision remains
unchanged. See the governing specifications for the final storage contract.
