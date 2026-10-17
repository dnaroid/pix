export interface SessionSweep { startedAt: number; since: number; identity: string; cacheRevision: string; incarnation?: string | undefined }
export const SESSION_WATERMARK_OVERLAP_MS: number;
export function beginSessionSweep(root: string, identity: string, signal: AbortSignal, now?: () => number): Promise<SessionSweep>;
export function completeSessionSweep(root: string, pass: SessionSweep, signal: AbortSignal, now?: () => number, coverage?: string): Promise<void>;
