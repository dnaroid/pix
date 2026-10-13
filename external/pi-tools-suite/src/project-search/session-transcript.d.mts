export interface TranscriptCandidate { id: string; path: string }
export interface TranscriptMessage { id: string; role: string; text: string; status: string }
export interface TranscriptChunk { start: number; end: number; text: string; hash: string; messageId: string; ordinal: number; role: string; status: string }
export interface TranscriptSnapshot extends TranscriptCandidate { fileStamp: string; revision: string; head: string; messages: TranscriptMessage[]; chunks: TranscriptChunk[] }
export const CHUNK_CHARS: number;
export function messageChunks(text: string): Pick<TranscriptChunk, "start" | "end" | "text" | "hash">[];
export interface TranscriptSkip { sessionId: string; path: string; reason: string; line?: number; code?: string; entryId?: string; parentId?: string }
export function readSessionTranscript(root: string, candidate: TranscriptCandidate, signal: AbortSignal, onSkip?: (diagnostic: TranscriptSkip) => void): Promise<TranscriptSnapshot | undefined>;
export function transcriptUnchanged(snapshot: TranscriptSnapshot, signal: AbortSignal): Promise<boolean>;
export function sessionContext(snapshot: TranscriptSnapshot, messageId?: string, budget?: number): string | undefined;
