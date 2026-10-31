<!-- pix:wiki-report {"version":1,"checkedAt":"2026-10-31T01:48:36.007Z","result":{"path":"wiki/decisions/0011-council-research-tools.md","documentHash":"90d0f5b26b3c294cbf2fb5d81c8d137849857c487a9b9f9cdc9b9047179f5b9a","modelRef":"zai/glm-5.3-flash","reportLanguage":"ru","checkedSources":12,"conflicts":[],"uncertainties":[],"reviewedSources":[],"notices":["Native reranking unavailable or its context changed; original ranking retained.","Не удалось подтвердить полноту или актуальность результатов поиска.","Native scan incomplete (I/O, concurrent edit or scan limit); previous snapshot retained.","Семантическая часть гибридного поиска завершилась не полностью.","Состав Wiki изменился или не удалось проверить его во время поиска; повторите проверку.","Документ, настройки или содержимое Wiki изменились во время проверки. Повторите её."],"coverage":{"scope":"retrieved-passages","checkedPassages":12,"candidateSources":50,"excerptedSources":9,"limits":["query-sampling","candidate-limit","source-limit","context-limit","passage-limit"]},"status":"incomplete"}} -->
# 0011 — Read-only council research capabilities

- Status: accepted
- Recorded: 2026-10-03
- Decided: 2026-10-03
- Owner / approval evidence: the user accepted enabling web_search/web_fetch
  for council participants and explicitly added repo_* commands. Conversation-only
  evidence; no separate durable conversation artifact is cited. The parent chose
  the isolated extension and strict allowlist implementation.
- Governing spec: [brainstorm](../assistants/brainstorm.md)
- Replaces / replaced by: none; extends [0009](0009-five-round-brainstorm.md)
  and [0010](0010-audit-council-modes.md) without changing their lifecycle or modes.
  Repo-loader placement is superseded by [0060](0060-subagent-read-only-repo-tools.md);
  web-loader placement is superseded by [0061](0061-subagent-scoped-ast-web-tools.md);
  other council research decisions remain in force. The original rationale below
  is retained as history.

## Context

Council participants previously requested read/grep only. Existing isolated
children disable automatic extensions, so adding custom tool names alone would
not make web and repository discovery available.

## Observations and sources

- The shared runner maps requested tools through model aliases; grep maps to
  shell for Codex, and custom names are not preserved by that mapper.
- The installed SDK treats --tools as a registry allowlist, not just initial
  activation. [Tests](https://github.com/dnaroid/pix/blob/cb504ee7b1000e4ed8df8acedc91ef759dbe5fb3/external/pi-tools-suite/test/brainstorm/research-extension.test.ts)
  verify actual SDK extension loading/inventory and deny unsafe calls.
- No paid research-quality or live web-service test supports quality claims.

## Decision

Load one council-only extension composing the existing web/repo modules, without
their setup/credential commands or the full suite. Supply a final canonical CLI
allowlist after model aliases, reselect registered allowed tools on lifecycle
events, and block non-allowlisted calls. Preserve shared provider/child guards.
Do not change general async-subagent behavior or model roster/round count.

Prompt participants to use relevant research, cite sources, disclose access gaps,
and keep private material out of external requests. Existing indexes/credentials
are prerequisites; council workers must not initialize or reconfigure them.

## Alternatives

- Tool names alone: cannot load missing extensions or survive the alias mapper.
- Full suite in children: unnecessary capabilities and recursive orchestration.
- Parent-only research: retains isolation but does not satisfy participant research.
- General runner rewrite: broader behavioral risk than a council-local override.

## Consequences

Participants can independently gather evidence with additional latency/network
cost inside existing timeouts. Index caches may refresh. Read-only refers to
product-source mutation tools, not an OS sandbox. Privacy, citation quality and
independence remain model instructions. Missing access yields coverage gaps.

## Revisit when

SDK CLI/tool-selection semantics change, new repo tools become mutating, privacy
requirements need a network sandbox, or measured research costs exceed value.

<!-- pix:wiki-check {"version":1,"status":"attempted","runId":"f061c4de-d66a-4d75-9c7e-aef1d8e78d55","contentHash":"90d0f5b26b3c294cbf2fb5d81c8d137849857c487a9b9f9cdc9b9047179f5b9a","checkedAt":"2026-10-31T01:48:36.009Z","maxDocumentChars":128000} -->
