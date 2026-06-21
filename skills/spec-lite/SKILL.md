---
name: spec-lite
description: Use this skill for creating, updating, or checking lightweight specs for existing code, risky changes, public behavior, bug fixes, or spec-code drift. Use it before or during non-trivial changes that touch security, data, persistence, public APIs, CLI/UI contracts, integrations, concurrency, architecture, or user-visible behavior with edge cases. Do not use it for trivial local edits.
argument-hint: "behavior, change, bug, or spec path to document/check"
---

# Spec Lite

Use the lightest spec process that preserves correctness. The goal is to make behavior and risk explicit without turning every change into a heavyweight design process.

## Core rules

- Do not change production code unless the user explicitly asks for implementation.
- Specs describe either current behavior or intended behavior; label which one clearly.
- Do not invent behavior. If evidence is missing or ambiguous, mark uncertainty explicitly.
- Prefer compact specs over exhaustive documents.
- Load only relevant files, tests, schemas, docs, migrations, entrypoints, and existing specs.
- Do not load all specs by default.
- Keep the spec close to the codebase convention when a specs directory, ADR folder, or feature-doc pattern already exists.

## When to create or update a spec

Create or update a lightweight spec when the work affects any of these areas:

- security, privacy, auth, or permissions;
- data, schemas, migrations, persistence, or file formats;
- public APIs, CLI behavior, UI contracts, events, or other external contracts;
- external integrations;
- payments, destructive operations, or irreversible workflows;
- background jobs, concurrency, cancellation, retries, or async behavior;
- cross-cutting architecture;
- user-visible behavior with non-trivial edge cases;
- bug fixes where expected behavior, compatibility, or regression risk is unclear;
- suspected drift between existing specs/docs/tests and code.

Do not require a spec for trivial local edits, mechanical renames, formatting-only changes, or obvious one-file fixes with no broader behavior impact.

## As-is spec workflow

Use this workflow for existing code or spec-code drift checks:

1. Identify the narrow behavior or contract to document.
2. Inspect relevant code, tests, docs, schemas, migrations, and entrypoints.
3. Identify current behavior and known gaps.
4. Mark claims using evidence labels:
   - confirmed by code;
   - confirmed by tests;
   - confirmed by docs;
   - inferred;
   - unknown.
5. Create or update a compact as-is spec.
6. If drift is found, report it separately from confirmed behavior.

## Change spec workflow

Use this workflow before risky implementation:

1. Define the goal.
2. Define scope and non-goals.
3. State expected behavior.
4. List affected contracts.
5. List risks, compatibility concerns, and migration concerns if any.
6. Define a verification path.
7. Then implement only the scoped change, if implementation was requested.

## Spec template

Use this template by default. Remove sections that are genuinely irrelevant, but keep `Type`, `Goal`, `Behavior`, `Related files`, `Verification`, and `Evidence` when possible.

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

## Output guidance

When the user asks only for a spec, write or update the spec and summarize:

- spec path;
- whether it is as-is or change-oriented;
- strongest evidence sources;
- important unknowns or drift;
- whether production code was left untouched.

When the user asks for implementation too, keep the spec scoped and practical, then implement only after the expected behavior and verification path are clear.
