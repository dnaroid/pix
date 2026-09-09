# Query existing spec knowledge

Use this mode to find relevant specs or answer a question grounded in existing
specifications without loading the whole corpus.

## If `.spec-wiki/` exists

1. Run `status`.
2. Read `.spec-wiki/index.md` and select only relevant primary specs.
3. Read those primary source documents before making detailed claims.
4. If a selected spec is `inputs-changed`, `spec-changed`, or otherwise stale,
   warn about freshness and use `focused-spec.md` when semantic verification is
   needed.

Do not treat `index.md` summaries as primary evidence when the source spec is
available.

## If no wiki exists

For a narrow question, search only for likely relevant specs and answer from
those sources. Do **not** bootstrap the full wiki unless the user asks for an
inventory/index or broad spec discovery.

## Existing project indexes

An existing README, overview, spec catalog, or TOC may be used as a discovery
hint, but its summaries are not primary spec knowledge. Follow links to the
underlying documents and ground claims there.

## Freshness

`fresh` means known source/input hashes match the last verified baseline. It does
not prove the spec is semantically correct forever.

`inputs-changed` is a review request, not proof of drift.
