# Status display

Goal: implement an adapter and status view using the established StatusSnapshot contract.
Coordinator: parent.

Current state: the contract is fixed, recorded and verified as contract-v1.
It defines data, errors and cancellation for both sides and remains applicable.
The user authorized bounded delegation and requested reduced elapsed time.
Two available workers can each complete their task in two hours; coordination
and integration overhead is about ten minutes. They share no mutable resources.

- [ ] A: implement the adapter; owns adapter code and its contract tests.
  Depends on contract-v1. Done when required adapter checks pass.
- [ ] B: implement the view using the contract fixtures; owns view code and its tests.
  Depends on contract-v1. Done when required rendering scenarios pass.
- [ ] I: connect both and verify updates, errors and cancellation.
  Depends on A and B. Done when combined acceptance checks pass.

No implementation work has started. No unresolved product decisions or gates.
