---
name: spec-wiki
description: >-
  Use this skill for behavior-changing project work or behavioral specs/contracts:
  write/verify as-is/change behavior from code/tests, find requirements, detect
  spec-code drift/impact, or maintain a spec wiki. Skip mechanical/refactor/
  debug-only changes and code-only impact with no contract/doc work. Not for
  runbooks or general docs.
---

# Spec Wiki

Primary specs are the source of truth. `.spec-wiki/` is only derived navigation
and freshness metadata. Specs may live anywhere and use any structure.

## Router

Choose one mode. Read only the referenced file unless the task expands.

- One spec: create/update/check/verify → `references/focused-spec.md`.
- Find/answer from specs → `references/query.md`.
- First discovery/index build → `references/bootstrap.md`.
- Refresh/audit/impact/repair → `references/maintenance.md`.
- Exact CLI/state/config details → `references/index-schema.md`.

Do not bootstrap or scan the whole repository for a narrow single-spec task.
Do not load all specs when the wiki can narrow retrieval.

## Invariants

- Never invent spec behavior; separate code/tests/docs evidence from inference.
- Distinguish current (`as-is`) from intended (`change`) behavior.
- Never treat generated indexes, overviews, catalogs, or TOCs as primary specs.
- Keep document lifecycle separate from spec type: active/proposed/historical/
  superseded is not the same question as as-is/change.
- Never infer semantic correctness from hashes alone. Changed inputs require
  verification, not automatic rewriting.
- After a material production-behavior change, run the post-change checkpoint in
  `references/maintenance.md` before declaring the task complete.
- Do not force specs into a new layout or template.
- Do not change production code unless the user asked for implementation.

## Bundled CLI

When wiki state is involved, use:

```bash
python3 <SKILL_DIR>/scripts/spec_wiki.py --root <PROJECT_ROOT> <command>
```

Commands: `discover`, `record`, `verify`, `relate`, `search`, `changes`, `impact`,
`remove`, `status`, `audit`, `affected`, `render`, `validate`.

The CLI owns deterministic discovery, relationships, hashes, state, and
rendering. The agent owns semantic classification and verification.
