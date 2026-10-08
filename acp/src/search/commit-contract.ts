import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";

import type { CommitSearchRequest } from "./contract.js";
export { SEARCH_COMMITS_METHOD } from "./contract.js";
export type { CommitSearchRequest, CommitMetadata, CommitSearchHit, CommitSearchResponse } from "./contract.js";
export function parseCommitSearchRequest(value: unknown): CommitSearchRequest {
  const invalid = (): never => { throw new RequestError(-32602, "Invalid commit search request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const p = value as Record<string, unknown>;
  const limit = p.limit ?? 20;
  if (typeof p.cwd !== "string" || p.cwd.length > 8192 || !isAbsolute(p.cwd) || p.cwd.includes("\0")
    || typeof p.query !== "string" || p.query.length > 2048 || p.query.includes("\0")
    || !Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 100) return invalid();
  return { cwd: p.cwd, query: p.query, limit: limit as number };
}
