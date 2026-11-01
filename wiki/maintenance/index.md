# Maintaining the Wiki

Wiki is the canonical home of project guides and specifications. This section records migration coverage, remaining conflicts and documentation rules.

[Wiki home](../index.md)

## Authoring rules

1. Add durable product guides, requirements and specifications under `wiki/`, next to the subject they describe. Link each new page from its section index; link major sections from the home page.
2. Keep a single authoritative contract per topic. Link requirements, user guidance, implementation notes and decisions rather than copying the same rules. Preserve requirement IDs, frontmatter, status, examples and tables.
3. Use document-relative Markdown links for pages, anchors, code and assets. Store documentation images/attachments under `wiki/assets/` or a subject-local asset directory. Use unique names for newly generated screenshots.
4. Keep `AGENTS.md`, `SKILL.md`, runtime-loaded role/skill companion files, legal/provenance notices and required package entry points at their tool-defined paths. Link to Wiki for general reference. Runtime-loaded plan-writing guidance is intentionally retained in the tools package.
5. Label implemented/as-is, proposed, experimental and historical content explicitly. Do not resolve contradictions by inventing behavior, silently discard rationale, or archive open work as completed. Record ambiguity in [known conflicts](known-conflicts.md).
6. Preserve ADR numbers, statuses and replacement links. Follow the [decision-log rules](../decisions/README.md); routine mechanical documentation moves do not need a new architectural decision.
7. After moves, update source comments, prompts, scripts, package allowlists and agent instructions when they refer to real project documents. Leave SDK paths, synthetic fixtures and historical evidence identities alone.
8. Run `npm run check:wiki` for local paths, anchors, media and index reachability. Use relevant focused tests for affected integrations. Do not run the full CI gate for documentation-only work.

## Minimize coupling to source layout

Document behavior, constraints, subsystem boundaries and decision rationale, not
an inventory of the current implementation. A behavior-preserving file move or
internal refactor should normally not require a Wiki update.

- Do not add routine `Implementation`, `Related files` or `Tests` lists of source
  paths. Find current implementation and test locations through repository search
  instead of maintaining a parallel file catalogue in each specification.
- Keep a code link only when its exact target is necessary for a documented
  action or explains a non-obvious boundary. State why the reader needs it;
  avoid repeating the same target across several sections.
- Describe verification in terms of observable outcomes and important failure
  cases, with a focused command when useful, rather than enumerating test files.
  Keep path-specific instructions when they are necessary to run the check.
- Preserve paths that are part of a contract: configuration/storage locations,
  required entry points, public interfaces and requested output locations.
  Preserve historical evidence identities and provenance; these are not live
  implementation inventories.
- Prefer a link to the authoritative guide or contract over a copied file map.
  Keep section navigation in indexes rather than repeating broad link lists on
  every page.

When simplifying existing pages, remove redundant inventories, not requirements,
verification scenarios, rationale or evidence needed to understand a decision.
Judge links by their purpose, not by a fixed link-count limit.

## Wiki and agent discovery

The project has no Wiki override in `.pi/workspace.jsonc`, so the standard `wiki/index.md` is the entry point. Markdown lives in the existing native knowledge source. No search provider, global embedding authorization or source selection was changed by this migration. Exclusions still apply; use lexical search for a no-provider discovery check.

See [Wiki behavior](../desktop/workbench/desktop-project-wiki.md),
[native search](../search/native-repository-search.md) and
[knowledge workflow](../search/repo-knowledge-agent-workflow.md).

## Migration records

- [Document inventory and lifecycle](inventory.md)
- [Old path → new path map](migration-map.md)
- [Known conflicts and evidence caveats](known-conflicts.md)
- [Migration verification and limits](verification.md)

<!-- pix:wiki-check {"version":1,"status":"clear","contentHash":"455015519ca03e0727352c19943c232792f09efa1972207e77c691085a5473f8","checkedAt":"2026-10-31T01:55:07.474Z","modelRef":"zai/glm-5.3-flash","scope":"retrieved-passages","checkedSources":12,"candidateSources":50,"reportLanguage":"ru"} -->
