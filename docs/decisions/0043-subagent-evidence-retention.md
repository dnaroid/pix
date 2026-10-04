# 0043 — Preserve subagent evidence on session shutdown

- Status: accepted
- Owner / approval evidence: user reported losing fresh photo/video reports on
  application restart and requested fixing shutdown deletion.
- Governing spec: [Async subagents](../../specs/async-subagents.md#cleanup-corecleanupts--stop-corestopts-coreprocessts)
- Replaces / replaced by: none

## Context and evidence

The extension's normal `session_shutdown` path stopped agents and immediately
deleted safely retired runs belonging to that parent session, removed registry
pointers and cleared project-wide bridged attachments. This bypassed age-based
cleanup, so even newly completed QA evidence disappeared. The existing tools
tests explicitly expected deletion. Desktop's separate background storage
cleanup has a 72-hour TTL; manual Clean intentionally remains immediate.

## Decision and scope

Separate process lifetime from evidence lifetime. Shutdown still stops the
closing session's agents with the existing cancellation and ownership rules,
but does not remove run directories, attachments or registry records. Retain
reload/fork exemptions and sibling-session isolation. Leave explicit cleanup,
Desktop TTL and manual Clean unchanged. Regression tests cover retained report
and media bytes, fresh-extension result resolution and process termination.

## Alternatives

- Keep deleting on shutdown: loses reports before users can inspect/export them.
- Add another shutdown TTL: duplicates existing retention owners unnecessarily.
- Keep only media: breaks reports, metadata and registry-based result lookup.

## Consequences and revisit triggers

Disk use can grow until explicit/TTL cleanup runs. Standalone Pi has no new
automatic retention timer. Retained evidence is still disposable and must be
exported for durable storage. Revisit if users need pinning, storage quotas or
a different retention period. No real Desktop restart QA is implied by the
deterministic extension tests.
