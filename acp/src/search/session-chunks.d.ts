import type { TranscriptCandidate, TranscriptSkip } from "./session-transcript.js";
export interface ChunkEmbedding { identity: string; dimension: number; authorized(signal: AbortSignal): Promise<boolean>; embed(inputs: string[], signal: AbortSignal, beforeSend?: () => Promise<void>): Promise<number[][]> }
export interface ChunkIndexResult { indexed: number; total: number; complete: boolean; skipped: number; deferred?: number; diagnostics?: TranscriptSkip[] }
export interface ChunkHit { id: string; path: string; title: string; messageId: string; start: number; end: number; snippet: string; score: number; semantic: boolean; byteOffset: number; byteLength: number; revision: string; fileStamp: string; head: string; active: true; hash: string }
export interface IndexedSession extends TranscriptCandidate { cwd: string; title: string; name: string; firstMessage: string; revision: string; fileStamp: string; head: string }
export function listIndexedSessions(root: string, signal: AbortSignal): Promise<IndexedSession[]>;
export function hasSessionChunkVectors(root: string,candidates: readonly TranscriptCandidate[],signal: AbortSignal,embedding: {identity: string;dimension: number}): Promise<boolean>;
export function indexSessionChunks(root: string,candidates: readonly TranscriptCandidate[],options: { signal: AbortSignal; embedding?: ChunkEmbedding; retry?: boolean; drain?: boolean; eligible?: (candidate: TranscriptCandidate, signal: AbortSignal) => Promise<boolean> }): Promise<ChunkIndexResult>;
export function searchSessionChunks(root: string,candidates: readonly TranscriptCandidate[],query: string,signal: AbortSignal,embedding?: {identity: string;dimension: number;query:number[]}): Promise<ChunkHit[]>;
