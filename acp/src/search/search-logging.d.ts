export type SearchDiagnosticRecord = {
  event: string;
  sessionId?: string;
  path?: string;
  reason?: string;
  line?: number;
  code?: string;
  message?: string;
  phase?: string;
  errorType?: string;
  suppressed?: number;
};
export function logSearchDiagnostic(root: string, diagnostic: SearchDiagnosticRecord): Promise<void>;
export function classifyIndexFailure(error: unknown): { errorType: string; code?: string };
export function isExpectedIndexCancellation(error: unknown): boolean;
export type BackgroundIndexFailureLogger = (root: string, error: unknown, phase?: string) => void;
export function createBackgroundIndexFailureLogger(options?: {
  write?: (root: string, diagnostic: SearchDiagnosticRecord) => void | Promise<void>;
  now?: () => number;
}): BackgroundIndexFailureLogger;
export const logBackgroundIndexFailure: BackgroundIndexFailureLogger;
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
