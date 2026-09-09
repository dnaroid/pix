# Query existing spec knowledge

Use this mode to find relevant specs or answer a question grounded in existing
specifications without loading the whole corpus.

## If `.spec-wiki/` exists

1. Turn the user's intent into a small retrieval bundle **in the current model**;
   do not make a separate model call. Keep the original query. For ordinary
   natural-language requests add **2–3 genuinely different** concise English
   aliases rather than echoing the same words:
   - behavior → canonical contract nouns/synonyms (`recover` → `recovery`,
     `wrong session update` → `async ownership lifecycle concurrency`);
   - failure/invariant vocabulary implied by the request (`prompt caching` →
     `cache stability`, `cannot delete before provider` → provider-seen/result
     retention);
   - likely component terminology only when the request itself gives enough
     evidence.
   For non-English requests, always include at least one English behavior alias
   and one compact contract-noun alias. Exact symbols or file paths are already
   strong retrieval keys and may be searched without extra aliases. Do not invent
   a feature name merely to make search easier.
2. Run one deterministic search with the bundle, for example:

   ```bash
   spec_wiki.py --root . search "<original>" \
     --also "<behavior alias>" \
     --also "<component/contract alias>" \
     --limit 8 --json
   ```

   Search uses title/topics/summary/spec path plus known code/spec/supersession
   relations. Exact relation paths receive strong weight.
3. Semantically rerank the returned candidates yourself from their compact
   metadata. Numeric score is candidate generation, not the final truth. Prefer
   entries that satisfy the whole intent, not entries matching one repeated
   domain word.
4. If `catalogFallbackRecommended` is true, search returns nothing, or the top
   candidates plainly miss an important part of the request, read the compact
   `.spec-wiki/index.md` and select candidates semantically from the catalog.
   **Never conclude that no relevant spec exists from lexical search alone.**
5. Prefer `active` entries over `proposed`, `historical`, or `superseded` ones.
   Use `--include-secondary` only when design/decision context is useful.
6. Read the selected primary source documents before making detailed claims.
   When uncertain, read a few plausible specs rather than silently dropping one.
7. If a selected spec is `unverified`, say that its semantic baseline has not
   been established. If it is `inputs-changed`, `spec-changed`, or otherwise stale,
   warn about freshness and use `focused-spec.md` when semantic verification is
   needed.

Do not run `status` before every narrow query: each search result already carries
its freshness status. Use `status` for broad wiki-health/audit questions.

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

`fresh` means known source/input hashes match an **explicit semantic-verification
baseline**. Bootstrap/classification alone produces `unverified`, never `fresh`.

`inputs-changed` is a review request, not proof of drift.
