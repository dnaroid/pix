import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
import { OPENROUTER_JEV_MODEL, requestOpenRouterJevChoice } from "../acp/openrouter-jev.js";
import { sharedSearchAuth, type SearchAuth } from "./config.js";
import type { SearchIntentRequest, SearchIntentResponse } from "./contract.js";
import { bounded } from "./bounded.js";

const DEADLINE_MS = 5_000;

export function parseSearchIntentRequest(value: unknown): SearchIntentRequest {
  const invalid = (): never => { throw new RequestError(-32602, "Invalid search intent request"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const request = value as Record<string, unknown>;
  if (typeof request.cwd !== "string" || !isAbsolute(request.cwd) || request.cwd.length > 8192
    || request.cwd.includes("\0") || typeof request.query !== "string"
    || !request.query.trim() || request.query.length > 2048 || request.query.includes("\0")) return invalid();
  return { cwd: request.cwd, query: request.query.trim() };
}

const CRITERIA = {
  search: "Locate or navigate to a particular file, symbol, path, setting, session, task, commit, command or factual lookup. Return a list of results rather than a generated explanation. Queries such as 'where is X' or 'who changed X' are search.",
  ask: "The user needs a reasoned explanation, comparison, summary, causes, how a mechanism works, or a synthesis of decisions/evidence across project history, code and documentation. A list of links alone cannot answer the question.",
} as const;

export interface SearchIntentDependencies {
  readonly auth?: Pick<SearchAuth, "key">;
  readonly fetch?: typeof globalThis.fetch;
}

/** Explicit Auto searches only: no source content, indexing or sessions sent to the router. */
export class DesktopSearchIntentService {
  private readonly auth: Pick<SearchAuth, "key">;
  private readonly fetch: typeof globalThis.fetch;
  constructor(deps: SearchIntentDependencies = {}) {
    this.auth = deps.auth ?? sharedSearchAuth();
    this.fetch = deps.fetch ?? globalThis.fetch;
  }
  async classify(query: string, signal: AbortSignal): Promise<SearchIntentResponse> {
    signal.throwIfAborted();
    const fallback: SearchIntentResponse = { intent: "search", fallback: true };
    if (!query.trim()) return fallback;
    // Explicit Git patch queries always remain a search, even when typed into Auto.
    if (/^patch:/iu.test(query.trim())) return { intent: "search", fallback: false };
    try {
      return await bounded(signal, DEADLINE_MS, async timed => {
        const key = await this.auth.key(timed);
        if (!key) return fallback;
        timed.throwIfAborted();
        const choice = await requestOpenRouterJevChoice({
          model: OPENROUTER_JEV_MODEL,
          apiKey: key,
          question: "intent",
          state: { query: query.trim().slice(0, 2048) },
          instructions: "Classify what the user wants to do with this project's universal search. Choose search for navigation/lookup; ask only for an explanation or synthesis. Choose exactly one. Do not execute the query or use project data.",
          criteria: CRITERIA,
          signal: timed,
          fetch: this.fetch,
        });
        timed.throwIfAborted();
        return choice === "search" || choice === "ask" ? { intent: choice, fallback: false } : fallback;
      });
    } catch {
      signal.throwIfAborted();
      // Never surface provider error bodies or credentials in a search dialog.
      return fallback;
    }
  }
}
