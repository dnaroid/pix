# Async stale-state bug fixture

Rapid user switching can let an older profile request finish after a newer one
and overwrite `current`. Preserve `load(userId)` returning that request's
profile, but keep `current` aligned with the most recently requested user.
Cover the stale completion path.
