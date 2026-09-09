# Focused spec work

Use this workflow for creating, updating, or checking one primary spec. Keep the
scope narrow; repository-wide indexing is optional unless it helps retrieval.

## Core rules

- Do not change production code unless implementation was requested.
- Do not invent behavior. Mark ambiguity as inferred or unknown.
- Prefer compact specs over exhaustive design documents.
- Read only relevant code, tests, schemas, migrations, entrypoints, docs, and
  existing specs.
- Follow the project's existing documentation convention when one exists.
- Describe current behavior as `as-is`; intended behavior as `change`.

## When a spec is useful

Prefer a focused spec for changes involving security/auth/privacy, data or
persistence, public APIs/CLI/UI/events, integrations, destructive operations,
async/concurrency/retries, cross-cutting architecture, non-trivial user-visible
edge cases, unclear bug-fix contracts, or suspected spec-code drift.

Do not force a spec for formatting-only edits, mechanical renames, or obvious
local changes without broader behavioral impact.

## As-is / drift workflow

1. Identify the narrow behavior or contract.
2. If a Spec Wiki already exists, use it only to locate related primary specs.
3. Inspect the relevant code, tests, docs, schemas, migrations, and entrypoints.
4. Separate claims as:
   - confirmed by code;
   - confirmed by tests;
   - confirmed by docs;
   - inferred;
   - unknown.
5. Write/update a compact as-is spec.
6. Report detected drift separately from confirmed behavior.
7. If the project uses Spec Wiki, `record` the spec/relations, then run `verify`
   only after the code/test semantic check is complete, and `render`.

## Change workflow

1. Define goal, scope, and non-goals.
2. State intended behavior.
3. Capture affected contracts and invariants.
4. Add relevant edge cases, compatibility, migration, and risks.
5. Define verification.
6. Implement only when requested.
7. After implementation, verify the spec against code/tests.
8. For a material production-behavior change, run the post-change checkpoint in
   `maintenance.md` using the paths changed by this task. This is required even
   when the spec you started from appears sufficient: newly introduced files may
   reveal previously unknown spec relationships.
9. If the project uses Spec Wiki, refresh metadata with `record`, repair durable
   relation changes with `relate`, then establish the verified baseline with
   `verify` only after implementation/test verification and the impact sweep.

If the task creates a new primary spec, record it immediately. If it moves a
primary spec, record/verify the new path before removing the old metadata entry.

## Default template

Use only when the repository has no stronger convention. Remove irrelevant
sections.

```markdown
# Spec: <name>

## Type
As-is | Change

## Goal
...

## Scope
...

## Non-goals
...

## Behavior
...

## Contracts
Inputs, outputs, APIs, CLI, UI, events, files, schemas.

## Invariants
...

## Edge cases
...

## Side effects
...

## Related files
...

## Verification
...

## Risks / unknowns
...

## Evidence
- Confirmed by code:
- Confirmed by tests:
- Confirmed by docs:
- Inferred:
- Unknown:
```

## Report back

Summarize the spec path, as-is/change mode, strongest evidence, important
unknowns/drift, and whether production code was changed.
