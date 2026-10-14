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
export type BackgroundIndexFailureLogger = (root: string, error: unknown, phase?: string) => void;
export function createBackgroundIndexFailureLogger(options?: {
  write?: (root: string, diagnostic: SearchDiagnosticRecord) => void | Promise<void>;
  now?: () => number;
}): BackgroundIndexFailureLogger;
export const logBackgroundIndexFailure: BackgroundIndexFailureLogger;
