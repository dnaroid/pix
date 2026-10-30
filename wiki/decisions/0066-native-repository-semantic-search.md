# 0066 — Consent-gated native repository embeddings without a history-index migration

> Authorization/provider scope superseded by [0068](0068-global-semantic-configuration.md).
> Native persistence and lifecycle rationale below remains applicable.

- Status: accepted
- Recorded: 2026-10-10
- Decided: 2026-10-10
- Owner / approval evidence: the user explicitly required semantics beyond FTS5 and selected the already configured embedding provider, with separate transmission consent and no paid verification. Storage/lifecycle choices are implementation decisions, not separately claimed user approvals.
- Governing spec: [Native repository search](../search/native-repository-search.md)
- Replaces / replaced by: supersedes [0065](0065-native-repository-search.md)'s lexical-only scope; retains its process and local FTS storage boundary.

## Context

The approved native repository slice must support semantic retrieval as well as lexical
search. Existing provider choices and paid history vectors must survive unchanged.
The shared suite must work in ordinary Pi as well as Desktop, without an active ACP session.

## Observations and sources

- [0065](0065-native-repository-search.md) records the existing history writer's long
  transaction spanning provider work; sharing it would couple local search to that lifecycle.
- User requirements above are conversation-only evidence, not a claim of a separate signed plan.
- Assumption: bounded, explicit-search indexing with visible coverage is useful before a
  persistent indexing service exists. Deterministic embeddings test mechanics, not real-model recall.

## Decision

Keep `.pi/search/files.sqlite` local/lexical. Add independent, consent-gated repository
vectors in `.pi/search/file-vectors.sqlite`, keyed by exact provider/configuration identity
and input hash. Preserve all existing databases/configuration and unreferenced paid vectors.
Reuse the saved provider rather than choose a replacement. Keep per-project repository
transmission consent separate from history/settings consent.
Own provider configuration in the suite's consent file. Historical external-configuration
fallback clauses have been removed. Expose consent as a Pi
user command as well as Desktop UI, not as a model-callable mutation tool.

Use short token-leased SQLite publications, never HTTP inside writer transactions. Bound
on-demand indexing; publish lexical results first in Desktop and report partial semantic
coverage. Revalidate consent/configuration/generation and reject stale completions.

## Alternatives

- Extend the shared history vector database: avoids a third file, but requires changing
  existing writers/schema guards and coordinating their lifecycle; defer that migration.
- Reuse another product's vector database directly: avoids duplicate embeddings but couples native
  storage to that product's internals and risks existing paid data.
- A persistent background indexer: improves large-repository coverage latency, but adds
  consent, scheduling, process ownership and cost-control lifecycles beyond this request.

## Consequences

Users may pay to embed repository content again; no claim of vector reuse is made.
Large projects need multiple explicit searches to reach full scoped coverage. Retaining old
vectors consumes bounded disk space; exhaustion degrades visibly rather than erasing data.
Current provider quality, cold latency and real semantic recall remain unverified without
separate permission for live provider evaluation. No structural/knowledge-review parity is implied.

## Revisit when

Measured coverage/latency requires background indexing; cache caps are routinely reached;
provider compatibility expands; or a reviewed common vector-writer lifecycle permits safe
consolidation without paid-vector loss.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"275566799d48fa0b435cf2b0fcbd5b4f846ff0903c72c6655b7f1bd9bdf1e5df","checkedAt":"2026-10-30T23:51:14.089Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":44,"reportLanguage":"ru"} -->
