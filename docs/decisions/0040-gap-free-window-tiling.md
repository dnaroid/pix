# 0040 — Gap-free window tiling

- Status: accepted
- Recorded: 2026-10-04
- Decided: 2026-10-04
- Owner / approval evidence: user requested filling the screen(s) without gaps,
  illustrated three windows with one full-height left tile and two right tiles,
  confirmed the interpretation and requested implementation in this conversation.
- Governing spec: [Desktop window tiling](../../specs/desktop-window-tiling.md)
- Replaces / replaced by: supersedes only uniform-grid selection in
  [0029 — Current-display-first window tiling](0029-window-tiling.md).

## Context

The previous planner emitted only the first N cells of a uniform grid. Incomplete
grids could leave unused work area. The user explicitly allows unequal window
sizes to eliminate these holes.

## Observations and sources

- Verified in `window_tiling.rs`: capacity depends on logical-point minimum sizes,
  at most three rows/columns, and current-display-first allocation.
- Conversation evidence: three windows may use one tall left tile and two stacked
  right tiles; filling the work area matters more than equal window sizes.
- Engineering choice: balanced columns generalize this example to other counts;
  the user did not specify every five/seven/eight-window arrangement.
- Hardware limitation: automated geometry tests do not prove native mixed-DPI or
  multi-display placement.

## Decision

Keep display allocation, minimum sizes, focus and native state handling intact.
Start with ceil(sqrt(N)) columns, clamped to fit available column/row capacity.
Spread N windows evenly across equal-width columns, putting shorter stacks on
the left. Each column fills the work-area height independently. Order tiles by
their top edge and then horizontal position, preserving row-major assignment on
regular grids and the active window at top-left. Work stays bounded to nine tiles
per display with no background observers or asynchronous placement changes.

## Alternatives

- Keep uniform grids: leaves holes for some window counts.
- Stretch only the last row: fills gaps but does not provide the user's tall-left
  three-window arrangement.
- Reduce native minimum sizes or spread all windows across all displays: outside
  this change; preserve the existing usable-size floor and display ordering.

## Consequences

Every used display is fully covered without overlaps. Incomplete grids intentionally
produce unequal window sizes. On constrained displays the layout can be a single
row or column; overflow windows still stay unchanged after display capacity runs out.

## Revisit when

Users request different dominant-window proportions, layout preferences, or a
different policy for distributing windows across displays.
