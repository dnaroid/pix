# Persisted settings migration

Goal: migrate existing settings after proving readiness.
Coordinator: parent.

- [ ] F: investigate the dry-run failure and repair its technical cause.
  Done when the required dry-run check succeeds.
- Gate migration, before M: Go requires a successful dry run.
  Observed current result: dry run failed with exit code 1.
  No-Go action: investigate the failure before migration.
- [ ] M: write the migrated settings. Done when migration and verification succeed.
  Depends on readiness proven by F.

The user authorized a migration after readiness is proven, but has not accepted
an exception for a failed check. The failure is technically investigable using
available code and diagnostics. No step has met its completion condition.
