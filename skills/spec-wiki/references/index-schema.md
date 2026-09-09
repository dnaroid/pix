# Spec Wiki state and CLI reference

<!-- markdownlint-disable MD013 -->

This reference describes the deterministic storage layer used by `spec-wiki`.

## Files

Default project-local paths:

```text
.spec-wiki/index.md
.spec-wiki/state.json
.spec-wiki/config.jsonc   # optional
```

`state.json` is authoritative for Spec Wiki metadata. `index.md` is a generated LLM-facing projection. Neither replaces the primary specification documents.

## State schema v1

Conceptual shape:

```json
{
  "schemaVersion": 1,
  "entries": {
    "docs/auth.md": {
      "path": "docs/auth.md",
      "title": "Authentication contract",
      "classification": "spec",
      "type": "as-is",
      "confidence": "high",
      "summary": "Authentication session lifecycle and refresh invariants.",
      "topics": ["auth", "sessions"],
      "relations": {
        "code": [
          {"path": "src/auth/session.ts", "source": "explicit"},
          {"path": "src/auth/store.ts", "source": "inferred"}
        ],
        "specs": [
          {"path": "docs/oauth.md", "source": "explicit"}
        ]
      },
      "verified": {
        "at": "2026-09-09T00:00:00Z",
        "sourceHash": "sha256:...",
        "codeHashes": {
          "src/auth/session.ts": "sha256:..."
        }
      }
    }
  }
}
```

State keys are normalized project-relative POSIX paths. Do not use numeric spec prefixes as IDs.

### Classifications

- `spec`: primary specification.
- `spec-like`: primary-ish specification knowledge worth indexing, but mixed/ambiguous.
- `meta-index`: derived inventory, overview, catalog, table of contents, or generated index.
- `design-only`: architecture/design/decision material without enough behavioral contract to treat as a spec.
- `guide`: tutorial, usage, runbook, operational documentation.
- `other`: irrelevant to the specification knowledge base.

Only `spec` and `spec-like` are rendered into `index.md`.

### Types

- `as-is`: describes current behavior.
- `change`: describes intended changed behavior.
- `mixed`: intentionally combines current and intended behavior.
- `unknown`: not confidently determined.

### Relationship provenance

- `explicit`: the CLI resolved a path/link from the primary source document itself.
- `inferred`: the agent added the relation after examining repository evidence.

Explicit does not mean semantically correct; it means the path relation is explicit in the source.

## Freshness

The `verified` block is a semantic-verification baseline, not merely a last-scan timestamp.

`audit` compares current content hashes to that baseline:

| Status | Meaning |
| --- | --- |
| `fresh` | source and tracked code inputs match the verified baseline |
| `spec-changed` | primary source document changed |
| `inputs-changed` | one or more tracked implementation inputs changed/disappeared |
| `spec+inputs-changed` | both source and tracked inputs changed |
| `missing-source` | primary source path no longer exists |
| `unverified` | no valid baseline exists |

`inputs-changed` is a review request, not proof of semantic drift.

## Optional config.jsonc

All fields are optional. Example:

```jsonc
{
  // Candidate document types scanned by default.
  "includeExtensions": [".md", ".mdx", ".rst", ".adoc", ".txt"],

  // Optional glob allowlist. Empty means all matching extensions.
  "include": ["docs/**", "architecture/**", "features/**"],

  // Additional exclusions.
  "exclude": ["legacy/**", "generated-docs/**"],

  // Force these paths/globs to be shortlisted as spec candidates.
  "forceSpecs": ["protocol/*.txt"],

  // Never shortlist these paths as specs.
  "ignoreSpecs": ["docs/spec-template.md"],

  // Candidate threshold; lower is broader/noisier.
  "minCandidateScore": 3,

  // Max bytes read from a candidate document.
  "maxFileBytes": 524288
}
```

The scanner always excludes its own state directory plus common dependency/build/cache directories. Git repositories use `git ls-files --cached --others --exclude-standard` when available so ignored generated/dependency trees are naturally omitted.

## Discovery heuristics

`discover` is deliberately a shortlist generator, not a semantic classifier. Signals include:

- spec/contract/requirements/RFC-like filenames or path segments;
- behavior/requirements/contracts/invariants/scope/non-goals/acceptance/verification headings;
- as-is/change language;
- code/test path references;
- meta/index language and dense links to other documentation.

`roleHint` can be `spec-candidate`, `meta-index`, or `weak-candidate`. The agent must still inspect the candidate before assigning a final classification.

## CLI commands

Global arguments:

```text
--root PATH       project root; defaults to Git root, then cwd
--state-dir PATH  alternate wiki state directory; relative paths are root-relative
--config PATH     alternate config.jsonc/json path
```

### discover

```bash
spec_wiki.py --root . discover --limit 40 --offset 0
spec_wiki.py --root . discover --all --json
```

Default output prioritizes unclassified and changed candidates above the configured threshold. `--all` includes unchanged previously classified candidates too.

After recording a page, rerun discovery from offset 0 because unchanged
classified documents leave the default shortlist. `--offset` is safe only when
state does not change between pages. `--all` also includes low-signal scanned
documents and is mainly diagnostic.

### record

```bash
spec_wiki.py --root . record \
  --path docs/auth.md \
  --classification spec \
  --type as-is \
  --confidence high \
  --summary "Authentication lifecycle and token invariants." \
  --topic auth --topic sessions \
  --code src/auth/session.ts \
  --related-spec docs/oauth.md
```

For `spec`/`spec-like`, `--summary` is required. Repeated `--code` and `--related-spec` arguments replace previously inferred relationships when supplied. Explicit relationships are always re-extracted from the current source.

Use `--clear-code` or `--clear-related-specs` to intentionally remove all
previously inferred relationships of that kind. These flags do not suppress
explicit relationships found in the source document itself.

Recording a document establishes a new verified hash baseline.

### remove

```bash
spec_wiki.py --root . remove --path docs/obsolete-spec.md
```

Removes only the Spec Wiki metadata entry. It never deletes the primary source
document. Use it after confirming that a missing source was deleted, or after
recording the replacement path for a moved spec.

### audit / status

```bash
spec_wiki.py --root . status
spec_wiki.py --root . audit --json
```

Reports freshness of known primary specs plus a bounded list of new/changed candidates.

### affected

```bash
spec_wiki.py --root . affected src/auth/session.ts src/auth/store.ts
```

Returns known primary specs whose source or tracked code relationships overlap the supplied changed paths. Absence from results is not proof of no impact because relationships are intentionally conservative.

### render

```bash
spec_wiki.py --root . render
```

Regenerates `index.md` from `state.json` and current freshness. Rendering does not update the verified baseline.

### validate

```bash
spec_wiki.py --root . validate
```

Checks schema version, entry shapes, classifications, summaries, normalized paths, and relationship safety. Missing primary sources and stale entries are warnings; malformed state is an error.
