import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_LINE = 1024 * 1024;
const MAX_FIRST_CHARS = 4096;
const MAX_FINAL_CHARS = 6144;

export interface SessionBoundaryText {
  readonly fingerprint: string;
  readonly firstText: string;
  readonly finalText: string;
}

export async function sessionFileFingerprint(path: string): Promise<string | undefined> {
  if (!path.endsWith(".jsonl")) return undefined;
  const stats = await lstat(path).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > MAX_FILE_BYTES) return undefined;
  return `${stats.size}:${stats.mtimeMs}`;
}

function messageText(content: unknown, limit: number): string {
  const blocks = typeof content === "string" ? [content] : Array.isArray(content)
    ? content.filter(item => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
      .map(item => item.text as string) : [];
  return blocks.join("\n").replace(/\s+/gu, " ").trim().slice(0, limit);
}

interface BoundaryNode {
  parentId: string | null;
  userText?: string;
  finalText?: string;
}

/** Read only user text and completed assistant text, following the active JSONL leaf branch. */
export async function readSessionBoundaries(path: string, signal: AbortSignal): Promise<SessionBoundaryText | undefined> {
  const fingerprint = await sessionFileFingerprint(path);
  if (!fingerprint) return undefined;
  signal.throwIfAborted();
  const nodes = new Map<string, BoundaryNode>();
  let leaf: string | undefined;
  const stream = createReadStream(path, { encoding: "utf8", signal });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      signal.throwIfAborted();
      const header = line.slice(0, 512);
      const id = /"id":"([^"]+)"/u.exec(header)?.[1];
      const parentMatch = /"parentId":(null|"([^"]+)")/u.exec(header);
      if (!id || !parentMatch) continue;
      const node: BoundaryNode = { parentId: parentMatch[2] ?? null };
      if (line.length <= MAX_MESSAGE_LINE && header.includes('"type":"message"')
        && (header.includes('"role":"user"') || header.includes('"role":"assistant"')
          || line.slice(0, 1536).includes('"role":"assistant"') || line.slice(0, 1536).includes('"role":"user"'))) {
        try {
          const entry = JSON.parse(line) as { message?: { role?: string; content?: unknown; stopReason?: string } };
          if (entry.message?.role === "user") node.userText = messageText(entry.message.content, MAX_FIRST_CHARS);
          if (entry.message?.role === "assistant" && entry.message.stopReason === "stop") {
            node.finalText = messageText(entry.message.content, MAX_FINAL_CHARS);
          }
        } catch { /* Incomplete/corrupt lines do not become search content. */ }
      }
      nodes.set(id, node);
      leaf = id;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  signal.throwIfAborted();
  if (fingerprint !== await sessionFileFingerprint(path)) return undefined;
  let firstText = "", finalText = "";
  let sawCompletedAnswer = false;
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const node = nodes.get(leaf);
    if (!node) break;
    if (node.userText !== undefined) firstText = node.userText;
    if (!sawCompletedAnswer && node.finalText !== undefined) {
      finalText = node.finalText;
      sawCompletedAnswer = true;
    }
    leaf = node.parentId ?? undefined;
  }
  return { fingerprint, firstText, finalText };
}
