# Bootstrap the Spec Wiki

Use for repository-wide discovery when no useful `.spec-wiki/state.json` exists,
or when the user explicitly asks to inventory scattered specifications.

The repository may have no `specs/` directory, no frontmatter, inconsistent
formats, and multiple documentation roots.

## Workflow

1. Run `discover --limit 40`.
2. Read only the high-signal shortlist.
3. Semantically classify each candidate:
   - `spec` — primary normative/descriptive specification;
   - `spec-like` — useful spec knowledge with mixed/ambiguous purpose;
   - `meta-index` — overview, inventory, catalog, TOC, generated index;
   - `design-only` — design/decision material without enough behavioral contract;
   - `guide` — tutorial/runbook/usage documentation;
   - `other` — not useful spec knowledge.
4. `record` every reviewed classification. For `spec`/`spec-like`, provide a
   concise summary, type, confidence, and a few retrieval topics.
5. After recording a batch, rerun `discover --limit 40` from offset 0; unchanged
   reviewed documents drop from the default shortlist.
6. Continue until useful candidates are exhausted or coverage becomes too broad.
   Report incomplete coverage rather than reading hundreds of weak candidates.
7. Run `render` and `validate`.

## What counts as a primary spec

A primary spec describes current or intended behavior, requirements, contracts,
invariants, externally observable semantics, acceptance criteria, compatibility
rules, or similarly testable expectations.

Classification is semantic. Filename, folder, headings, and links are signals,
not requirements.

## Meta/index exclusion

Do not index derived inventories as primary specs. They are useful only to find
primary documents missed by heuristics. This avoids recursive knowledge such as:

`spec -> old index summary -> new wiki summary`.

## Relationships

The CLI extracts resolvable source links/paths as `explicit` relationships. Add
`--code` or `--related-spec` only for relationships actually established from
repository evidence; these are recorded as `inferred`.

Use project-relative path identity, never numeric prefixes as unique IDs.

For exact command/config/state details, read `index-schema.md`.
