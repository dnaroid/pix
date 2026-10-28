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
