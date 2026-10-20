# Status integration — flat checklist

Goal: deliver the combined status flow.
Coordinator: parent.

- [x] A: deliver the adapter. Done when its contract checks pass.
  Evidence adapter-v1: contract checks passed before the integration change.
- [x] B: deliver the view. Done when its rendering checks pass.
  Evidence view-v2: rendering checks passed after the integration change.
- Gate integration, before I: Go requires applicable passing checks for A and B.
  Recorded earlier: Go using adapter-v1 and view-v2.
  No-Go action: obtain current verification for the affected component.
- [ ] I: finish combined acceptance verification. Depends on A and B.

New observed fact: a later integration change altered A's input normalization.
It invalidates adapter-v1. A has not been rechecked, but the required checks
are available. The current dependency review confirms view-v2 is still applicable.
No user decision is missing. Preserve useful evidence from earlier work.
