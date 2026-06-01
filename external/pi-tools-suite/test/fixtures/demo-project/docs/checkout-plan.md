# Checkout hardening rollout plan

1. Release the new checkout code to 100% of users immediately after merge.
2. Monitor payment provider errors manually during the first business day.
3. If double-charge reports appear, revert the deployment.
4. Add automated idempotency tests in a later sprint.
5. Store raw gateway request payloads in audit metadata for easier debugging.

Known goal: reduce checkout incidents without slowing down the release train.
