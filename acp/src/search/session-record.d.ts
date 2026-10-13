import type { TranscriptMessage } from "./session-transcript.js";
export interface SessionRecord {
  type?: string; id?: string; parentId?: string | null; cwd?: string; name?: string;
  message?: TranscriptMessage;
}
export function parseSessionRecord(line: string, signal: AbortSignal): Promise<{ entry?: SessionRecord; reason?: string }>;
