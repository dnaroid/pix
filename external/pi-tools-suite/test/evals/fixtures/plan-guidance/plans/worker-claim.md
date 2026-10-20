# Integrate adapter and view

Goal: deliver the combined status flow.
Coordinator: parent.

- [ ] A: deliver the adapter. Done when its contract checks pass.
- [x] B: deliver the view. Done when its rendering checks pass.
  Evidence view-v2: rendering checks passed against the current view revision.
- Gate integration, before I: Go requires applicable passing checks for A and B.
  No-Go action: obtain missing checks before integration.
- [ ] I: integrate both and verify the combined flow. Depends on A and B.

Current handoff: worker A sent only "done". Its implementation is present, but
it provided no check commands, observed results or other verification evidence.
A's required checks are available to the parent. B's evidence remains applicable.
No previous A verification exists; no product decision or user permission is missing.
