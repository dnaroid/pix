import type { TranscriptCandidate } from "./session-transcript.js";
export const SESSION_IDLE_MS: number;
export class SessionIndexDeferred extends Error { constructor(); }
export class SessionIdlePolicy {
  constructor(root: string, now?: () => number);
  observe(id: string, running: boolean, touch?: boolean): Promise<void>;
  flush(): Promise<void>;
  state(candidate: TranscriptCandidate, signal: AbortSignal): Promise<{ eligible: boolean; revision: string; changedAt?: number }>;
  eligible(candidate: TranscriptCandidate, signal: AbortSignal): Promise<boolean>;
  dispose(): Promise<void>;
}
export class IdleSessionSelection {
  complete: boolean;
  cacheRevision?: string;
  constructor(policy: SessionIdlePolicy);
  reset(): void;
  useCache(revision: string): void;
  succeeded(candidate: TranscriptCandidate): void;
  select<T extends TranscriptCandidate & { createdAt?: number | undefined; changedAt?: number | undefined }>(candidates: readonly T[], signal: AbortSignal, since?: number): Promise<T[]>;
}
