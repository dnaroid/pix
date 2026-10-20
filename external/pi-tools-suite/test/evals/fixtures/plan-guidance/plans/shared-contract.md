# Timestamp display

Goal: implement an adapter and view that agree on timestamp semantics.
Coordinator: parent.

Current state: two proposed implementation tasks touch different files, but A
assumes seconds while B assumes milliseconds for the same StatusSnapshot field.
The existing authoritative specification and client usage can resolve this
technical question. They have not yet been inspected for this change.
The user has already authorized implementation and bounded delegation.

- [ ] C: inspect the existing specification and client usage, then establish
  the shared timestamp contract. Done when the discrepancy is resolved from evidence.
- [ ] A: implement the adapter; owns adapter code and tests.
  Needs the established contract. Done when contract checks pass.
- [ ] B: implement the view; owns view code and tests.
  Needs the established contract. Done when rendering checks pass.
- [ ] I: connect both and verify timestamp behavior. Depends on A and B.

The original draft suggested starting A and B together because their files differ.
No step is complete and no gate or verification result has been recorded.
