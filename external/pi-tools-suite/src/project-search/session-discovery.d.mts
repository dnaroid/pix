import type { TranscriptCandidate } from "./session-transcript.mjs";
export function nativeSessionDirectory(root: string, agentDir: string): string;
export class SessionCandidateCatalog {
  constructor(options?: { now?: () => number; watching?: boolean });
  list(root: string, agentDir: string, signal: AbortSignal, extraPaths?: readonly string[]): Promise<(TranscriptCandidate & { createdAt: number })[]>;
  snapshot(root: string, agentDir: string, signal: AbortSignal, extraPaths?: readonly string[], mapping?: readonly { piSessionPath: string; sessionId: string; piSessionId: string; namedTitle?: string | undefined; title?: string | undefined }[]): Promise<string>;
  dispose(): void;
}
export interface SessionTitleCandidate extends TranscriptCandidate { name?: string; firstMessage: string; fileStamp: string }
export function readSessionTitle(root: string, candidate: TranscriptCandidate, signal: AbortSignal): Promise<SessionTitleCandidate | undefined>;
