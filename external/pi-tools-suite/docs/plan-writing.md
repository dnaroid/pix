# Writing implementation plans

Read this guide before creating or materially revising a durable implementation
plan. Browsing, executing a plan, or updating a verified checkbox does not require
loading it again. Follow the current project's instruction files and the user's
explicit requirements if they differ from these defaults.

## When to write one

- Write a plan when requested, when work needs review before execution, or when
  the work clearly spans sessions. Do not turn trivial work into a planning task.
- Save Markdown under `.pi/plans/<descriptive-kebab-case-name>.md` in the current
  project unless the user specifies another location. Use subfolders for real
  grouping, not generated/cache/temp directories or hidden files.
- Keep one plan per goal; update a relevant existing plan instead of duplicating it.
- A durable plan records the intended outcome, decisions and acceptance checks.
  Session todos track execution; do not create duplicate saved tasks or change
  their statuses without the user's authorization.

## Write for a fresh agent with no chat history

- Make the plan self-contained: goal, reason, current state, relevant file paths,
  symbols and specs. Never depend on “as discussed” or unstated chat context.
- Ground the plan in relevant current source and project instructions. Verify
  referenced paths, symbols and check commands; label unverified details as
  assumptions or discovery steps with an observable result and named dependents.
- Use the user's language. Prefer a short plan proportional to the task; aim for
  less than 150 lines rather than treating every section below as mandatory.
- Link to source files instead of pasting code, logs or whole documents.
- Do not include secrets, tokens, personal data or credential-bearing URLs.

## Useful sections — omit empty ones

1. **Goal:** the observable outcome, in one to three sentences.
2. **Context:** current behavior, important files/contracts, project constraints.
3. **Scope / Out of scope:** what changes and what must remain untouched.
4. **Decisions and open questions:** a short reason for each consequential choice.
   Resolve questions from available code, specifications and permitted checks
   first. Mark remaining questions that prevent safe execution with `BLOCKER:`
   and name the affected steps. Ask the user when resolution needs their intent,
   authorization or information the agent cannot obtain; do not invent
   requirements or silently choose a risky answer. Reuse applicable decisions
   and authorization already given.
5. **Steps:** an ordered `- [ ]` checklist. Each step names its target and a
   “done when” condition. State dependencies explicitly. For larger multi-stage
   work, group steps into phases (see below). Note useful parallel groups and
   their dependencies (see Parallel work).
6. **Risks:** only concrete risks, each with a mitigation. When relevant, consider
   races, stale async completion, cancellation, teardown, resource leaks,
   compatibility, migration, rollback and destructive actions.
7. **Acceptance:** specific commands, tests or manual scenarios with expected
   results proving the required outcome. A final DoD refers to these criteria
   rather than repeating them. Select the scope required by the project's
   instructions, not an invented exhaustive gate. Separate automated checks
   from manual verification.

## Parallel work

- Consider subagents when expected savings or independent review outweigh
  coordination and integration costs, within project/tool delegation policy;
  a large plan alone does not require delegation.
- Record dependencies and parallel groups. Establish shared contracts before
  dependent implementation starts; different files alone do not establish independence.
- Give each subagent the goal, relevant context, dependencies, write scope,
  “done when” conditions and required checks.
- Assign exclusive write ownership while tasks overlap, including shared mutable
  resources; coordinate a handoff or serialize overlapping writes.
- Name one integrator to reconcile outputs, resolve conflicts and update the plan.
- Do not mark a step complete solely from a subagent's completion status: retain
  its concrete verification evidence and confirm applicability after integration.
- Before closing the group or phase, complete its required combined checks and
  assess the applicable Acceptance or DoD. Reuse applicable evidence under the
  verification rules below.

Example, after establishing the shared `StatusSnapshot` contract:

```markdown
- [ ] A, parallel with B: implement the adapter; owns adapter code and tests.
  Done when its required contract checks pass.
- [ ] B, parallel with A: implement the view using contract fixtures; owns view
  code and tests. Done when the required rendering scenarios pass.
- [ ] Integrator, depends on A and B: connect both and verify status updates,
  errors and cancellation. Done when the combined acceptance checks pass.
```

## Larger plans: phases, Definition of Done and gates

Use phases when later work depends on earlier work being proven: risky or
hard-to-reverse changes, work spanning sessions, or independently verifiable
delivery increments. Otherwise keep a flat checklist with “done when” conditions
and Acceptance; do not impose phases, DoD or gates on small plans.

Keep these terms distinct and reference shared checks instead of duplicating them:

- **Acceptance criteria:** the required outcome observable by the user or system.
- **Step “done when”:** the local completion condition of one checklist item.
- **Phase DoD (Definition of Done):** what must be true and verified before later
  work builds on this phase. Name the relevant checks: tests, typechecks, a manual
  scenario, dry run, or updated docs/contracts when they changed. Require only
  what the change and project instructions actually need.
- **Final DoD:** Acceptance met with the required verification observed, no open
  `BLOCKER:`, and agreed cleanup/follow-ups accounted for. Refer to Acceptance.
- **Go/No-Go gate:** an evidence-based decision before expensive, hard-to-reverse
  work or work relying on an unproven assumption. Define Go evidence and the
  action on No-Go. Name the exact phase, step or action it protects and evaluate
  it before starting that work. Required evidence must be obtainable before
  crossing the gate. Not every phase needs a gate.

Suggested phase shape:

```markdown
### Phase 2 — <name> (depends on Phase 1)
- **Gate — before <named phase, step or action>:** Go if <concrete evidence>;
  No-Go → <stop, roll back or replan>.
- [ ] <step and target> — done when <condition>
- **DoD:** <observable conditions and the specific checks proving them>
```

Gates and blockers must be usable from the plan alone, without this guide:

- Decide Go only on observed evidence from this session or earlier evidence with
  its source that remains applicable. A missing, failed or `not run` required
  gate check means No-Go. An exception needs explicit user acceptance of the
  risk, must respect project constraints, and must preserve the actual check
  results. Record the exception and any remaining verification.
- Record `Go — <evidence>` or `No-Go — <reason; next action>` next to the gate.
- If a gate requires a human decision (access, destructive actions, product
  trade-offs) not already covered by the user's authorization, state it and ask;
  do not self-approve or treat Go as authorization.
- A `BLOCKER:` pauses affected steps/phases and their dependents. Independent
  work may continue only when that independence is established from the plan
  and current code; do not assume it to bypass a blocker.
- After No-Go, a disproved assumption or scope change, update affected steps,
  phases, DoD and dependencies in place. Explain the decision and keep completed evidence.
- Never weaken a DoD or gate just to proceed. Correct an invalid criterion as an
  explicit reasoned decision; ask when this changes the agreed outcome.

## Execution and honest status

- Before execution, check the plan against current code and project instructions.
  Resolve technical questions from available evidence first; pause affected work
  and its dependents while unresolved `BLOCKER:` items or material contradictions remain.
- New future steps start unchecked. Mark `[x]` only after verification and retain
  brief evidence: command/test/scenario and observed result. Preserve prior
  evidence honestly; do not imply it was rerun in the current session.
  For reused evidence, name its source and the checked state/scope or environment
  needed to establish applicability.
- While executing, save each verified item as `[x]` in the plan file as soon as
  its step completes, so saved progress stays current for readers. Track finer
  sub-steps in the session checklist instead of duplicating plan items there.
- If later work invalidates earlier completion or verification, reopen the
  affected checklist items and state why. Mark affected gates as No-Go until
  their required evidence is valid again or an explicit exception is recorded
  under the gate rules above. Preserve earlier evidence as historical and
  retain evidence that remains applicable. This also applies to flat checklists.
- Record each Go/No-Go decision and its evidence before crossing the gate.
  Re-run earlier checks when fresh evidence is required or later changes may have
  invalidated them, not merely because a new phase or session started.
- Record skipped, blocked or unavailable checks as `not run: reason`. Never
  describe a test as passed without observing its result.
- Re-read the plan before writing progress to avoid overwriting someone else's
  changes. If it changed materially, reconcile or ask instead of replacing it.
- Keep the document as current actionable state, not a progress diary. Remove
  obsolete future steps; preserve useful decisions and verification evidence.
