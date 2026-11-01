import { open, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { getAgentDir, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { nativeSessionDirectory } from "../search/session-discovery.js";

/** Only fields consumed by the ACP map: never retain transcript/search text. */
export type NativeSessionMetadata = Pick<SessionInfo,
  "path" | "id" | "cwd" | "name" | "parentSessionPath" | "modified" | "firstMessage">;
type Cached = { revision: string; info: NativeSessionMetadata | undefined };
const revision = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Owned by one adapter. Callers coalesce project reads through NativeSessionCatalog. */
export class NativeSessionMetadataCache {
  private readonly projects = new Map<string, Map<string, Cached>>();

  constructor(
    private readonly agentDir = getAgentDir(),
    private readonly readFile = readNativeSessionMetadata,
  ) {}

  clear(): void { this.projects.clear(); }

  async list(cwd: string, signal: AbortSignal): Promise<NativeSessionMetadata[]> {
    signal.throwIfAborted();
    const directory = nativeSessionDirectory(cwd, this.agentDir);
    const names = (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })).filter(name => name.endsWith(".jsonl")).sort();
    const cache = this.projects.get(directory) ?? new Map<string, Cached>();
    this.projects.set(directory, cache);
    const live = new Set(names.map(name => join(directory, name)));
    for (const path of cache.keys()) if (!live.has(path)) cache.delete(path);
    const result: NativeSessionMetadata[] = [];
    for (const path of live) {
      signal.throwIfAborted();
      try {
        const before = await stat(path);
        if (!before.isFile()) { cache.delete(path); continue; }
        const stamp = revision(before);
        let cached = cache.get(path);
        if (cached?.revision !== stamp) {
          const info = await this.readFile(path, signal);
          signal.throwIfAborted();
          const after = await stat(path);
          cached = { revision: stamp, info };
          // A concurrent append/rewrite is not acknowledged as already read.
          // The next refresh retries this file, not every historical transcript.
          if (revision(after) === stamp) cache.set(path, cached);
          else cache.delete(path);
        }
        if (cached.info) result.push(cached.info);
      } catch (error) {
        cache.delete(path);
        signal.throwIfAborted();
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    signal.throwIfAborted();
    return result;
  }
}

/** SDK-compatible title, fork and activity projection without allMessagesText. */
export async function readNativeSessionMetadata(path: string, signal: AbortSignal): Promise<NativeSessionMetadata | undefined> {
  signal.throwIfAborted();
  const file = await open(path, "r");
  let stream: ReturnType<typeof file.createReadStream> | undefined;
  let lines: ReturnType<typeof createInterface> | undefined;
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size === 0) return;
    // Bound this read to the observed file size even while a writer appends.
    stream = file.createReadStream({ encoding: "utf8", autoClose: false, signal, end: stats.size - 1 });
    lines = createInterface({ input: stream, crlfDelay: Infinity });
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let firstMessage = "";
    let lastActivity: number | undefined;
    for await (const line of lines) {
      signal.throwIfAborted();
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return;
        header = entry;
        continue;
      }
      if (entry.type === "session_info") name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      const message = entry.type === "message" ? entry.message : undefined;
      if (!message || typeof message !== "object" || !("content" in message) || (message.role !== "user" && message.role !== "assistant")) continue;
      const activity = typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
      if (Number.isFinite(activity)) lastActivity = Math.max(lastActivity ?? 0, activity);
      if (!firstMessage && message.role === "user") {
        if (typeof message.content === "string") firstMessage = message.content;
        else if (Array.isArray(message.content)) {
          firstMessage = message.content
            .filter((block: { type?: string; text?: unknown } | null) => block?.type === "text" && typeof block.text === "string")
            .map((block: { text: string }) => block.text).join(" ");
        }
      }
    }
    signal.throwIfAborted();
    if (!header) return;
    const headerTime = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
    let modified = Number.isFinite(headerTime) ? headerTime : stats.mtimeMs;
    if (lastActivity !== undefined && lastActivity > 0) modified = lastActivity;
    return {
      path: resolve(path), id: header.id as string, cwd: typeof header.cwd === "string" ? header.cwd : "",
      ...(name ? { name } : {}),
      ...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
      modified: new Date(modified),
      firstMessage: firstMessage || "(no messages)",
    };
  } finally {
    lines?.close();
    stream?.destroy();
    await file.close();
  }
}
