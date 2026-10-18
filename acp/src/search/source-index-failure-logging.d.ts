export type SourceIndexFailureReason = "busy" | "incompatible" | "policy_changed" | "source_disabled" | "policy_invalid"
  | "authorization_changed" | "ownership_expired" | "provider_unavailable" | "corpus_too_large" | "corpus_invalid"
  | "locked" | "needs_continue" | "watcher_failed" | "aborted" | "other";
export function classifyIndexFailureReason(error: unknown): SourceIndexFailureReason;
export type SourceIndexFailureLogger = (root: string, source: "settings" | "tasks", error: unknown, reason?: SourceIndexFailureReason) => void;
export function createSourceIndexFailureLogger(options?: {
  sink?: () => unknown;
  now?: () => number;
}): SourceIndexFailureLogger;
export const logSourceIndexFailure: SourceIndexFailureLogger;
