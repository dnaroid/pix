import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import type { RagRequest, RagSource, RagSourceKind } from "./rag-contract.js";

export function parseRagRequest(value: unknown): RagRequest {
  const invalid = (): never => { throw new RequestError(-32602, "Invalid RAG request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  const text = (v: unknown, max: number): string => {
    if (typeof v !== "string" || v.length > max || v.includes("\0")) return invalid();
    return v;
  };
  const requestId = text(p.requestId, 100);
  const cwd = text(p.cwd, 8192);
  const query = text(p.query, 2048).trim();
  if (!/^[a-zA-Z0-9-]{8,100}$/u.test(requestId) || !isAbsolute(cwd)
    || !query || !Array.isArray(p.sources) || p.sources.length > 12) return invalid();
  const seen = new Set<string>();
  const kinds = new Set<RagSourceKind>(["settings", "sessions", "tasks", "commits", "code", "knowledge"]);
  const sources: RagSource[] = p.sources.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
    const s = value as Record<string, unknown>;
    const id = text(s.id, 512);
    const kind = s.kind;
    if (!id || seen.has(id) || !kinds.has(kind as RagSourceKind)) return invalid();
    seen.add(id);
    const title = text(s.title, 512);
    const snippet = text(s.snippet, 2500);
    if (!title) return invalid();
    const source: RagSource = { id, kind: kind as RagSourceKind, title, snippet };
    if (s.content !== undefined) sourceProperty(source, "content", text(s.content, 4096));
    if (s.path !== undefined) {
      const path = text(s.path, 1024);
      if (!path || path.startsWith("/") || path.startsWith("~") || path.includes("\\")
        || path.split("/").some(part => !part || part === "." || part === "..")) return invalid();
      sourceProperty(source, "path", path);
    }
    if (s.startLine !== undefined || s.endLine !== undefined) {
      const from = s.startLine, to = s.endLine;
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)
        || (from as number) < 1 || (to as number) < (from as number)
        || (to as number) - (from as number) > 1500) return invalid();
      sourceProperty(source, "startLine", from as number);
      sourceProperty(source, "endLine", to as number);
    }
    if (s.hash !== undefined) {
      const hash = text(s.hash, 64);
      if (!/^[a-fA-F0-9]{40,64}$/u.test(hash)) return invalid();
      sourceProperty(source, "hash", hash);
    }
    if (s.sessionId !== undefined) sourceProperty(source, "sessionId", text(s.sessionId, 256));
    if ((kind === "code" || kind === "knowledge") && (!source.path || source.startLine === undefined)) return invalid();
    if (kind === "commits" && !source.hash) return invalid();
    if (kind === "sessions" && !source.sessionId) return invalid();
    return source;
  });
  return { requestId, cwd, query, sources };
}

function sourceProperty<K extends keyof RagSource>(source: RagSource, key: K, value: RagSource[K]): void {
  (source as unknown as Record<string, unknown>)[key] = value;
}
