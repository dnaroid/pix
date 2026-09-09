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
   Treat files under eval/fixture/example/testdata trees, skill resources, and
   agent-role definition directories as examples/runtime configuration by
   default, not project primary specs, unless repository evidence explicitly
   says that document itself is normative project behavior.

   Location is not a reason to downgrade a document. A document outside a
   `specs/` directory that explicitly declares its behavioral Type/Lifecycle
   and defines testable behavior/contracts/invariants should normally be
   `spec`. Reserve `spec-like` for genuinely mixed-purpose or ambiguous
   documents, not for clear subsystem contracts living under `docs/`.
4. `record` every reviewed classification. For `spec`/`spec-like`, provide a
   concise summary, type, lifecycle, confidence, and a few retrieval topics.
   Classification/indexing is **not** semantic verification: bootstrap entries
   normally remain `unverified` until a focused code/test review occurs.
5. After recording a batch, rerun `discover --limit 40` from offset 0; unchanged
   reviewed documents drop from the default shortlist.
6. Continue until useful candidates are exhausted or coverage becomes too broad.
   Report incomplete coverage rather than reading hundreds of weak candidates.
7. Run `render` and `validate`.

Do not call `verify` merely because a document was read during discovery. Call
it only after checking the document's behavioral claims against the relevant
implementation/tests (or other authoritative evidence for a proposed contract).

## What counts as a primary spec

A primary spec describes current or intended behavior, requirements, contracts,
invariants, externally observable semantics, acceptance criteria, compatibility
rules, or similarly testable expectations.

Classification is semantic. Filename, folder, headings, and links are signals,
not requirements.

## Lifecycle

Classify primary documents separately from their as-is/change type:

- `active` — current authoritative contract;
- `proposed` — intended contract not yet established as current behavior;
- `historical` — useful milestone/history, not current precedence;
- `superseded` — replaced by a newer primary spec; add `--superseded-by`;
- `unknown` — lifecycle cannot be established safely.

Useful default reasoning:

- an as-is/current-behavior contract is normally `active` unless clearly
  historical;
- a change document whose behavior is already implemented and still governs the
  system is normally `active`;
- an intended/not-yet-implemented change is `proposed`;
- milestone documents whose former non-goals/features were later superseded are
  `historical` unless a newer document explicitly replaces their whole contract;
- use `superseded` only when a specific replacement exists and record that edge.

The CLI requires explicit `--type` and `--lifecycle` on the first primary-spec
record so omission cannot silently become precedence metadata.

Use `--supersedes` / `--superseded-by` for known precedence instead of leaving
overlapping documents as coequal active specs.

## Meta/index exclusion

Do not index derived inventories as primary specs. They are useful only to find
primary documents missed by heuristics. This avoids recursive knowledge such as:

`spec -> old index summary -> new wiki summary`.

## Relationships

The CLI extracts resolvable source links/paths as `explicit` relationships. Add
`--code` or `--related-spec` only for relationships actually established from
repository evidence; these are recorded as `inferred`.

The resolver tries the source directory, nearest package/project roots, and the
repository root. Review `unresolvedReferences` after bootstrap: they are path-like
hints that could not be resolved deterministically and may need an inferred
relation or a source-doc fix.

Use project-relative path identity, never numeric prefixes as unique IDs.

For exact command/config/state details, read `index-schema.md`.
