# Maintain an existing Spec Wiki

Use for refresh, audit, changed-code impact analysis, missing/moved specs, and
repair of an existing `.spec-wiki/` knowledge base.

## Routine refresh

1. Run `status`.
2. Re-read changed primary specs and reclassify changed non-primary documents
   when `impact` marks them for classification/reclassification.
3. For `inputs-changed`, inspect the affected behavior against code/tests before
   updating any spec claim or verified baseline.
4. Use the focused workflow in `focused-spec.md` when semantic verification is
   required.
5. `record` updated metadata/relations first. This does not clear drift.
6. After semantic verification succeeds, run `verify --path <spec>` to establish
   the new source/input baseline.
7. Run `render` and `validate`.

## Mandatory post-change checkpoint

Run this after any **material production-behavior change** before reporting the
task complete. Skip it for formatting-only/mechanical edits that cannot affect a
behavioral contract.

1. Prefer the exact paths changed by the current task and run:

   ```bash
   spec_wiki.py --root . impact <task-paths...>
   ```

   If task-scoped paths are unavailable, `impact` with no paths inspects the Git
   working tree against `HEAD`. On an already-dirty worktree this is broader than
   the current task, so do not attribute unrelated changes to the user task.
2. Treat every `knownAffected` primary spec as a semantic-review candidate.
3. Treat every material `uncoveredPath` as a **mandatory semantic impact sweep**,
   even when `affected` returned nothing. Inspect the changed code/diff, form 2–3
   distinct English retrieval formulations, run hybrid `search --also ...`, and
   semantically rerank the compact candidates. Use the catalog fallback described
   in `query.md` when search recommends it or coverage is incomplete.
4. If the sweep reveals a previously unknown durable spec→code dependency, repair
   the relation map with `relate --add-code ...` (or update the source spec's
   Related files and `record` it). Do not add relations merely because paths share
   names.
5. If a tracked relation is obsolete or a file moved, remove/replace only the
   inferred edge with `relate --remove-code ...`; explicit source links should be
   corrected in the primary spec itself. Any relation-map change invalidates the
   old verified baseline until semantic verification succeeds again.
6. Every changed/new document reported by `impact.changedDocuments` must be
   classified for the current task **regardless of heuristic score**. A score-0
   changed `.txt` may still be a real contract.
7. After semantic review, update affected specs only when their behavioral claims
   changed. Then `record` changed metadata/source, `verify` each reviewed current
   spec, `render`, and `validate`.

The checkpoint is successful when material changed paths have either a known and
reviewed spec relationship or a documented semantic decision that no current spec
is affected. `affected` alone is never sufficient proof of no impact.

## Freshness states

- `fresh`: source and tracked inputs match the verified hash baseline.
- `spec-changed`: primary document changed; review summary/classification.
- `inputs-changed`: tracked implementation input changed; semantic review needed.
- `spec+inputs-changed`: both changed.
- `missing-source`: primary source disappeared or moved.
- `unverified`: no valid semantic-verification baseline.

Never rewrite behavior automatically from `inputs-changed`.

Historical/superseded specs remain searchable knowledge but are not treated as
current review obligations. Use lifecycle and supersession relations to keep old
milestone contracts from competing with current specs.

## Impact analysis

Use `affected <paths...>` after code changes to identify specs with known tracked
relationships to those paths. It is a conservative hint: absence from the
result does not prove no spec is affected.

Prefer explicit source links. Add inferred implementation relations only after
inspection; do not guess paths to improve coverage.

Review unresolved path hints reported by `status`/`validate`, especially for
active as-is specs. A current as-is spec with no tracked implementation inputs
cannot provide useful automatic drift detection.

`impact` additionally reports changed paths with **no known** current spec
relationship. Those paths are where semantic discovery is most important.

## New specs and discovery coverage

- A spec created by the current task should be `record`ed immediately; do not wait
  for a later repository scan.
- `impact` exposes every changed/new document-like file for classification even
  when normal discovery heuristics would rank it below the candidate threshold.
- Routine `status` still discovers ordinary new/changed high-signal spec
  candidates across the repository.
- Before releases, after large refactors, or when coverage is in doubt, run a
  **bounded deep coverage audit**:

  ```bash
  spec_wiki.py --root . discover --all-unclassified --limit 40
  ```

  This intentionally bypasses the heuristic threshold for unclassified document-
  like files. Page it carefully on large repositories and classify only after
  reading the document itself. This is the safety net for committed low-signal
  specs that are no longer visible in the current Git diff.

## Missing or moved specs

- Confirmed deletion: `remove --path <old-path>` removes metadata only.
- Move: `impact` reports the old tracked source as missing and the new document
  as a classification candidate. Record the new source first, preserve/repair its
  relations and lifecycle, verify it, then remove the old metadata entry.

## Safety

- Primary specs remain the source of truth.
- Do not modify existing project indexes merely to satisfy Spec Wiki.
- Do not normalize arbitrary specs into a mandatory format.
- Hash freshness is structural, not semantic correctness.
- Verified freshness also fingerprints the relation map. Adding/removing tracked
  inputs invalidates the previous baseline even when no source/code bytes changed.
- Preserve manual classifications unless source/evidence justifies a change.

## Report back

Summarize wiki path, primary-spec count, unclassified candidates, specs needing
review and why, missing/moved sources, and whether primary specs or production
code were modified.

For exact command/config/state details, read `index-schema.md`.
