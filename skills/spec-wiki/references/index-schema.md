# Spec Wiki state and CLI reference

<!-- markdownlint-disable MD013 -->

This reference describes the deterministic storage layer. Primary specification
documents remain the source of truth.

## Files

```text
.spec-wiki/index.md      # compact generated routing index
.spec-wiki/state.json    # semantic metadata + structural/verification baselines
.spec-wiki/config.jsonc  # optional discovery overrides
```

## State schema v2

Conceptual primary entry:

```json
{
  "path": "docs/auth.md",
  "title": "Authentication contract",
  "classification": "spec",
  "type": "as-is",
  "lifecycle": "active",
  "confidence": "high",
  "summary": "Authentication session lifecycle and refresh invariants.",
  "topics": ["auth", "sessions"],
  "relations": {
    "code": [
      {"path": "src/auth/session.ts", "source": "explicit"}
    ],
    "specs": [
      {"path": "docs/oauth.md", "source": "inferred", "kind": "related"}
    ]
  },
  "unresolvedReferences": [],
  "indexed": {
    "at": "2026-09-09T00:00:00Z",
    "sourceHash": "sha256:..."
  },
  "verified": {
    "at": "2026-09-09T00:05:00Z",
    "sourceHash": "sha256:...",
    "relationsHash": "sha256:...",
    "codeHashes": {
      "src/auth/session.ts": "sha256:..."
    }
  }
}
```

State keys and all stored paths are normalized project-relative POSIX paths.

### Classification

- `spec` — primary behavioral/normative specification.
- `spec-like` — primary-ish knowledge with mixed/ambiguous purpose.
- `meta-index` — inventory, overview, catalog, TOC, generated index.
- `design-only` — design/decision material without enough behavioral contract.
- `guide` — tutorial, runbook, usage/operational documentation.
- `other` — not useful specification knowledge.

Only `spec`/`spec-like` are primary specs. `design-only` may be searched as
secondary context with `search --include-secondary`.

### Type

- `as-is` — describes current behavior.
- `change` — intended/changed behavior.
- `mixed` — intentionally contains both.
- `unknown` — not safely determined.

### Lifecycle

Lifecycle is separate from Type:

- `active` — current authoritative contract.
- `proposed` — intended contract that is not yet current.
- `historical` — useful milestone/history, not current precedence.
- `superseded` — replaced by a newer primary document.
- `unknown` — precedence cannot be established safely.

For known replacement relationships use:

- `kind: related`
- `kind: supersedes`
- `kind: superseded-by`

### Indexed vs verified

`indexed` is refreshed by `record`. It means the document was classified and
summarized at that exact source hash.

`verified` is written only by `verify`. It means the agent has semantically
checked the spec against its relevant implementation/tests/evidence and accepted
the current tracked-input baseline. The baseline also fingerprints the current
code/spec relation map. Adding or removing a relation therefore invalidates
freshness until semantic review and `verify` establish a new baseline.

Therefore a clean bootstrap produces `unverified` primary specs, not `fresh`.

## Freshness statuses

- `fresh` — source and tracked code inputs match an explicit verified baseline.
- `unverified` — indexed but no semantic-verification baseline exists.
- `spec-changed` — source differs from indexed/verified baseline.
- `inputs-changed` — one or more tracked implementation inputs differ/missing.
- `spec+inputs-changed` — both source and implementation inputs changed.
- `missing-source` — primary source disappeared/moved.

Hash status is structural evidence only; `inputs-changed` requests semantic
review and must not rewrite behavior automatically.

## Relationship discovery

Explicit path/link resolution tries, in order:

1. the source document directory;
2. ancestor package roots containing markers such as `package.json`,
   `pyproject.toml`, `Cargo.toml`, `go.mod`, or `Package.swift`;
3. repository root.

This lets a doc under `external/package/docs/` resolve `src/foo.ts` against the
package root. Simple `{a,b}` path groups are expanded.

If the document explicitly says that paths/references below are relative to a
backticked existing project directory (for example `external/tool-suite/`), that
directory is also used as a resolution base. This covers root-level specs that
document one nested package using package-relative paths.

Path-like tokens that still cannot resolve are stored in
`unresolvedReferences`. They are diagnostic hints, not silently discarded.

## Optional config.jsonc

```jsonc
{
  "includeExtensions": [".md", ".mdx", ".rst", ".adoc", ".txt"],
  "include": ["docs/**", "architecture/**", "features/**"],
  "exclude": ["legacy/**", "generated-docs/**"],
  "forceSpecs": ["protocol/*.txt"],
  "ignoreSpecs": ["docs/spec-template.md"],
  "minCandidateScore": 3,
  "maxFileBytes": 524288
}
```

The scanner excludes its own state plus common dependency/build/cache dirs.
When Git is available it uses tracked + unignored untracked files; hashing also
works without Git.

## CLI

Global options:

```text
--root PATH       project root; defaults to Git root, then cwd
--state-dir PATH  alternate wiki directory; relative paths are root-relative
--config PATH     alternate config.jsonc/json path
```

### discover

```bash
spec_wiki.py --root . discover --limit 40
spec_wiki.py --root . discover --all --json
spec_wiki.py --root . discover --all-unclassified --limit 40
```

Produces a heuristic shortlist. `roleHint` is not a semantic classification.
After recording a page, rerun from offset 0 because the shortlist shrinks.
`--all-unclassified` is a bounded periodic coverage audit: it bypasses candidate
score for unclassified document-like files while still excluding known
fixture/skill-resource noise unless forced by config.

### record

```bash
spec_wiki.py --root . record \
  --path docs/auth.md \
  --classification spec \
  --type as-is \
  --lifecycle active \
  --confidence high \
  --summary "Authentication lifecycle and refresh invariants." \
  --topic auth --topic sessions \
  --code src/auth/session.ts \
  --related-spec docs/oauth.md
```

`record` updates classification, summary, topics, relationships, unresolved
references, and the `indexed` source hash. It **does not verify** the entry.
The first `spec`/`spec-like` record requires explicit `--type` and
`--lifecycle` (use `unknown` only after semantic inspection cannot decide).

Additional spec relationship flags are repeatable:

```text
--supersedes PATH
--superseded-by PATH
```

`--clear-code` and `--clear-related-specs` remove previously inferred relations;
explicit source links are re-extracted each time.

### verify

```bash
spec_wiki.py --root . verify --path docs/auth.md
```

Run only after semantic review. It hashes the current source and every tracked
code/test input plus the current relation map and establishes the new verified
baseline. Missing tracked inputs fail rather than being silently accepted.

### relate

Use `relate` to repair inferred relations without resupplying the full semantic
record:

```bash
spec_wiki.py --root . relate --path docs/auth.md --add-code src/auth/refresh.ts
spec_wiki.py --root . relate --path docs/auth.md --remove-code src/auth/legacy.ts
```

It also supports add/remove variants for related specs, `supersedes`, and
`superseded-by`. Explicit relations extracted from the primary source are not
removed by this command; correct the source document instead. A real relation
change makes the previous verified baseline non-fresh through `relationsHash`.

### search

```bash
spec_wiki.py --root . search "session cancellation retry" --limit 8
spec_wiki.py --root . search "как восстановить историю" \
  --also "session recovery raw history after compaction" \
  --also "session recovery tools" --json
spec_wiki.py --root . search "context gateway" --include-secondary --json
```

Searches state metadata directly: title, topics, summary, spec path, known code
relations, related-spec relations, and supersession edges. Exact spec/relation
paths have strong weight. Relation token scoring uses concrete leaf names rather
than generic directory segments.

`--also` is repeatable. The CLI scores each formulation independently, then
merges them deterministically. The intended caller is the current LLM: preserve
the original request and, for natural-language intents, add 2–3 genuinely
different English formulations (canonical contract nouns/synonyms plus implied
failure/invariant vocabulary) without making another model call. Exact paths and
symbols usually need no expansion.

JSON output includes `confidence`, `catalogFallbackRecommended`,
`semanticRerankRecommended`, coverage metrics, and per-query match evidence.
These are routing hints, not semantic proof. The agent still reranks candidates
from compact metadata. If fallback is recommended, results are empty, or the
candidate set plainly misses part of the intent, inspect the compact generated
`index.md` before deciding no relevant spec exists.

Active specs rank above proposed/historical/superseded ones. This is the normal
retrieval path; reading the entire generated index is a semantic fallback.

### status / audit

```bash
spec_wiki.py --root . status
spec_wiki.py --root . audit --json
```

Reports current/proposed primary count, fresh/unverified/review counts,
unresolved reference count, missing sources, and new/changed candidates.
`needs review` counts structural drift/missing sources; cleanly indexed but never
verified specs are reported separately as `unverified`.

### affected

```bash
spec_wiki.py --root . affected src/auth/session.ts src/storage
```

Returns current/proposed primary specs whose source or tracked code relations
overlap supplied paths. Historical/superseded specs are skipped.

### changes / impact

```bash
spec_wiki.py --root . changes --json
spec_wiki.py --root . impact src/auth/session.ts src/auth/refresh.ts --json
spec_wiki.py --root . impact --base HEAD --json
```

`changes` reports Git worktree changes, untracked files, and renames while
excluding Spec Wiki's own state directory.

`impact` is the deterministic post-change maintenance primitive. Explicit paths
keep it scoped to the current task; with no paths it uses Git changes against
`--base`. It returns known affected specs, uncovered changed paths, every changed
document-like file (even score-0), missing/moved tracked specs, and a
`semanticSweepRequired` flag. Uncovered paths are search seeds for LLM semantic
impact review, not proof that a spec is missing.

### render

```bash
spec_wiki.py --root . render
```

Generates a compact one-line-per-spec routing index. Historical/superseded specs
and secondary design references are separate sections. Full summaries remain in
state and are retrieved through `search`.

### remove

```bash
spec_wiki.py --root . remove --path docs/old-contract.md
```

Removes metadata only. For a move, record the new path before removing the old.

### validate

```bash
spec_wiki.py --root . validate
```

Checks schema/path/hash/relationship safety. Stale/unverified current specs,
unresolved path hints, and active as-is specs without implementation relations
are warnings rather than malformed-state errors.
