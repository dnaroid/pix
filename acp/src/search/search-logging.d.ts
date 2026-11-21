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
  cause?: IndexFailureCause;
};
export type IndexFailureCause = "busy" | "compat" | "provider" | "io" | "corrupt" | "ownership" | "policy" | "needs_continue" | "other";
export function logSearchDiagnostic(root: string, diagnostic: SearchDiagnosticRecord): Promise<void>;
export function classifyIndexFailure(error: unknown): { errorType: string; cause: IndexFailureCause; code?: string };
export function isExpectedIndexCancellation(error: unknown): boolean;
export type BackgroundIndexFailureLogger = (root: string, error: unknown, phase?: string) => void;
export function createBackgroundIndexFailureLogger(options?: {
  write?: (root: string, diagnostic: SearchDiagnosticRecord) => void | Promise<void>;
  now?: () => number;
}): BackgroundIndexFailureLogger;
export const logBackgroundIndexFailure: BackgroundIndexFailureLogger;
