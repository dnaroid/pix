# Maintain an existing Spec Wiki

Use for refresh, audit, changed-code impact analysis, missing/moved specs, and
repair of an existing `.spec-wiki/` knowledge base.

## Routine refresh

1. Run `status`.
2. Re-read and reclassify changed primary spec documents only.
3. For `inputs-changed`, inspect the affected behavior against code/tests before
   updating any spec claim or verified baseline.
4. Use the focused workflow in `focused-spec.md` when semantic verification is
   required.
5. `record` verified specs, then `render` and `validate`.

## Freshness states

- `fresh`: source and tracked inputs match the verified hash baseline.
- `spec-changed`: primary document changed; review summary/classification.
- `inputs-changed`: tracked implementation input changed; semantic review needed.
- `spec+inputs-changed`: both changed.
- `missing-source`: primary source disappeared or moved.
- `unverified`: no valid semantic-verification baseline.

Never rewrite behavior automatically from `inputs-changed`.

## Impact analysis

Use `affected <paths...>` after code changes to identify specs with known tracked
relationships to those paths. It is a conservative hint: absence from the
result does not prove no spec is affected.

Prefer explicit source links. Add inferred implementation relations only after
inspection; do not guess paths to improve coverage.

## Missing or moved specs

- Confirmed deletion: `remove --path <old-path>` removes metadata only.
- Move: record the new source first, then remove the old metadata entry.

## Safety

- Primary specs remain the source of truth.
- Do not modify existing project indexes merely to satisfy Spec Wiki.
- Do not normalize arbitrary specs into a mandatory format.
- Hash freshness is structural, not semantic correctness.
- Preserve manual classifications unless source/evidence justifies a change.

## Report back

Summarize wiki path, primary-spec count, unclassified candidates, specs needing
review and why, missing/moved sources, and whether primary specs or production
code were modified.

For exact command/config/state details, read `index-schema.md`.
