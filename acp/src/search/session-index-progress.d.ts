export interface SessionIndexProgressState {
  phase: "waiting_for_lease" | "reading" | "checking_cache" | "provider" | "saving";
  sessionId?: string;
  sessionsTotal: number;
  sessionsChecked: number;
  sessionsSkipped: number;
  chunksDiscovered: number;
  cachedChunks: number;
  savedVectors: number;
  requestsStarted: number;
  requestsCompleted: number;
}
export function sessionIndexProgress(root: string, sessionsTotal: number,
  write?: (root: string, record: Record<string, unknown>) => Promise<void>): {
    state: SessionIndexProgressState;
    finish(status: "completed" | "incomplete" | "failed" | "cancelled"): Promise<void>;
  };
