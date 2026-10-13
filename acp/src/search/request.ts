import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import type { SearchConfigRequest, SearchIndexRequest, SearchQueryRequest, SearchSetting, SearchSyncRequest, SemanticTasksRequest } from "./contract.js";

const invalid = (): never => { throw new RequestError(-32602, "Invalid Desktop search request"); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 8192): string => {
  if (typeof value !== "string" || value.length > max) return invalid();
  return value;
};
function cwd(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path) || path.includes("\0")) return invalid();
  return path;
}
export function parseSearchConfigRequest(value: unknown): SearchConfigRequest {
  const p = record(value);
  if (Object.keys(p).some(key => !["cwd", "includeSourceStatus", "includeSessionSnapshot"].includes(key))) return invalid();
  if (p.includeSourceStatus !== undefined && typeof p.includeSourceStatus !== "boolean") return invalid();
  if (p.includeSessionSnapshot !== undefined && typeof p.includeSessionSnapshot !== "boolean") return invalid();
  return { cwd: cwd(p.cwd), ...(p.includeSourceStatus !== undefined ? { includeSourceStatus: p.includeSourceStatus } : {}),
    ...(p.includeSessionSnapshot !== undefined ? { includeSessionSnapshot: p.includeSessionSnapshot } : {}) };
}
export function parseSearchSyncRequest(value: unknown): SearchSyncRequest {
  const p = record(value);
  if (Object.keys(p).some(key => !["cwd", "settings"].includes(key))) return invalid();
  return { cwd: cwd(p.cwd), settings: parseSettings(p.settings) };
}
export function parseSearchIndexRequest(value: unknown): SearchIndexRequest {
  const p = record(value);
  if (Object.keys(p).some(key => !["cwd", "source", "settings"].includes(key))) return invalid();
  if (p.source !== "settings" && p.source !== "sessions" && p.source !== "tasks" && p.source !== "commits") return invalid();
  if (p.source !== "settings") {
    if (Object.hasOwn(p, "settings")) return invalid();
    return { cwd: cwd(p.cwd), source: p.source };
  }
  // Unlike legacy query/sync, explicit indexing accepts only authored metadata.
  if (!Array.isArray(p.settings) || p.settings.some(value => Object.keys(record(value))
    .some(key => !["id", "section", "label", "description", "synonyms"].includes(key)))) return invalid();
  return { cwd: cwd(p.cwd), source: p.source, settings: parseSettings(p.settings) };
}
function parseSettings(value: unknown): SearchSetting[] {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  return value.map(value => {
    const s = record(value);
    if (!Array.isArray(s.synonyms) || s.synonyms.length > 30) return invalid();
    // Values, drafts and presentation-only fields never reach indexing.
    return { id: text(s.id, 256), section: text(s.section, 256), label: text(s.label, 512),
      description: text(s.description), synonyms: s.synonyms.map(v => text(v, 512)) };
  });
}
export function parseSemanticTasksRequest(value: unknown): SemanticTasksRequest {
  const p = record(value);
  if (Object.keys(p).some(key => !["cwd", "query", "limit"].includes(key))) return invalid();
  const query = text(p.query, 2048).trim();
  if (!query || !Number.isSafeInteger(p.limit) || Number(p.limit) < 1 || Number(p.limit) > 30) return invalid();
  return { cwd: cwd(p.cwd), query, limit: Number(p.limit) };
}
export function parseSearchQueryRequest(value: unknown): SearchQueryRequest {
  const p = record(value);
  if (!Array.isArray(p.types) || p.types.some(t => t !== "settings" && t !== "sessions") || p.types.length > 2) return invalid();
  const settings = parseSettings(p.settings);
  const limit = p.limit ?? 30;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) return invalid();
  return { cwd: cwd(p.cwd), query: text(p.query, 2048), types: [...new Set(p.types)] as SearchQueryRequest["types"], settings, limit: limit as number };
}
