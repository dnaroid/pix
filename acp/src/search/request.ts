import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import type { SearchConfigRequest, SearchQueryRequest, SearchSetting } from "./contract.js";

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
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") return invalid();
  if (p.sessionTitlesEnabled !== undefined && typeof p.sessionTitlesEnabled !== "boolean") return invalid();
  if (p.messageFilterEnabled !== undefined) return invalid();
  return { cwd: cwd(p.cwd), ...(p.enabled === undefined ? {} : { enabled: p.enabled as boolean }),
    ...(p.sessionTitlesEnabled === undefined ? {} : { sessionTitlesEnabled: p.sessionTitlesEnabled as boolean }),
    ...(p.apiKey === undefined ? {} : { apiKey: text(p.apiKey, 4096).trim() }) };
}
export function parseSearchQueryRequest(value: unknown): SearchQueryRequest {
  const p = record(value);
  if (!Array.isArray(p.types) || p.types.some(t => t !== "settings" && t !== "sessions") || p.types.length > 2) return invalid();
  if (!Array.isArray(p.settings) || p.settings.length > 1000) return invalid();
  const settings: SearchSetting[] = p.settings.map(value => {
    const s = record(value);
    if (!Array.isArray(s.synonyms) || s.synonyms.length > 30) return invalid();
    // Deliberately reconstruct the allowlist: values, drafts and unknown fields never reach indexing.
    return { id: text(s.id, 256), section: text(s.section, 256), label: text(s.label, 512),
      description: text(s.description), synonyms: s.synonyms.map(v => text(v, 512)) };
  });
  const limit = p.limit ?? 30;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) return invalid();
  return { cwd: cwd(p.cwd), query: text(p.query, 2048), types: [...new Set(p.types)] as SearchQueryRequest["types"], settings, limit: limit as number };
}
