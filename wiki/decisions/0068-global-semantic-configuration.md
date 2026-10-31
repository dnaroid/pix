# 0068 — Global semantic configuration is authorization

- Status: accepted
- Recorded: 2026-10-11
- Decided: 2026-10-11
- Owner / approval evidence: user explicitly requested configuration-as-consent for ordinary Pi and Desktop, then ordered implementation in this conversation.
- Governing spec: [Native repository search](../search/native-repository-search.md)
- Replaces / replaced by: replaces authorization/provider scope in [0066](0066-native-repository-semantic-search.md); its persistence/lifecycle rationale remains applicable.

## Context

Separate project configuration and Desktop source consent flags leave sources with
inconsistent activation and identities. The user requests one explicit provider
configuration for all projects and sources, without further opt-ins or an ACP dependency.

## Observations and sources

- Prior behavior is recorded in [0066](0066-native-repository-semantic-search.md).
- Approval is conversation-only. No paid retrieval quality or provider availability is
  asserted; existing caches are not evidence of current authorization.
- Native and history caches have different persistence contracts and must not be
  destructively migrated to activate this feature.

## Decision

Storage clarification (2026-10-11): the user subsequently requested that this
configuration live in the global suite file. The authority is now `search.embedding`
in `~/.config/pi/pi-tools-suite.jsonc`, preserving JSONC comments and unrelated suite
fields. The originally selected `~/.config/pi/semantic-search.json` is no longer
read or migrated; project-local overrides do not authorize semantics. The global
authorization decision and its privacy/cost rationale are unchanged.

The explicit `search.embedding` object in `~/.config/pi/pi-tools-suite.jsonc` selects a provider
and authorizes eligible semantic processing across all Pi/TUI/ACP/Desktop sources and
projects. No independent enable/consent flags. Missing/invalid configuration is local-only.
User command and native Desktop configuration disclose uploads/costs; agents never select
or configure providers on the user's behalf. Credentials remain in environment/shared Pi
auth. Legacy configuration/consents are ignored, not migrated.

Configuration signatures and cache identities guard stale/cross-model use. Disabling
removes configuration, stops new work and retains paid vectors. Transmitted bytes cannot
be recalled. Explicit lexical searches still send nothing.

## Alternatives

- Keep per-project/source authorization: narrower scope, but contrary to requested behavior.
- Make ACP/Desktop the authority: would make ordinary Pi depend on an optional host.
- Infer authorization from keys/caches: ambiguous intent and potential silent uploads.

## Consequences

One configuration gives consistent activation and provider selection. The accepted privacy
and cost scope is broader: eligible data from any searched project/source can be uploaded.
Disclosure and a global disable path are required. Old flags no longer activate semantics;
users explicitly save central configuration. Incompatible caches must fail safely or
coexist, never trigger destructive repair.

## Revisit when

Users need project policy isolation, enterprise allowlists, multiple provider profiles,
or evidence shows global authorization cannot be communicated reliably.

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"e70364ae955a4ed2e97b7e7ddfd07784853bcc248ef815b2477d6a7334df9168","checkedAt":"2026-10-31T12:44:44.410Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":62,"reportLanguage":"ru"} -->
