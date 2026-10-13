import type { TranscriptMessage } from "./session-transcript.mjs";
export interface SessionRecord {
  type?: string; id?: string; parentId?: string | null; cwd?: string;
  message?: TranscriptMessage;
}
export function parseSessionRecord(line: string, signal: AbortSignal): Promise<{ entry?: SessionRecord; reason?: string }>;
