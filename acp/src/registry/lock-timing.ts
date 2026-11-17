/**
 * Registry checkout lock and Git timing. Dependency-free so Desktop can derive
 * its RPC timeouts from the same values the ACP lock uses.
 */

/** A lock whose owner stopped heartbeating (e.g. a SIGKILLed ACP) is reclaimed after this. */
export const REGISTRY_LOCK_STALE_MS = 120_000;
/** Owner heartbeat interval; must stay well below the stale window. */
export const REGISTRY_LOCK_UPDATE_MS = 10_000;
/** Delay between lock acquisition attempts while another owner holds it. */
export const REGISTRY_LOCK_RETRY_MS = 1_000;
/** Maximum acquisition attempts before an operation fails as busy. */
export const REGISTRY_LOCK_RETRIES = 600;
/** Upper bound for one networked registry Git command (clone, fetch, push). */
export const REGISTRY_GIT_NETWORK_TIMEOUT_MS = 180_000;
