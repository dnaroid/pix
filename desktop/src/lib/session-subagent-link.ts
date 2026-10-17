import {
  PIX_SUBAGENT_META_KEY,
  type SubagentSessionContext,
  type SubagentSessionLink,
  type SubagentSessionModel,
  type SubagentSessionState,
} from "../../../acp/src/acp/subagent-sessions-contract";

export type { SubagentSessionContext, SubagentSessionLink, SubagentSessionModel, SubagentSessionState };

/** Read-only sub-agent viewer identity from session protocol metadata. */
export function subagentSessionLink(metadata: unknown): SubagentSessionLink | undefined {
  if (!isRecord(metadata)) return undefined;
  const candidate = metadata[PIX_SUBAGENT_META_KEY];
  if (!isRecord(candidate) || !nonEmpty(candidate.runDir) || !nonEmpty(candidate.agentId)) return undefined;
  if (candidate.parentSessionId !== undefined && !nonEmpty(candidate.parentSessionId)) return undefined;
  return {
    runDir: candidate.runDir,
    agentId: candidate.agentId,
    ...(candidate.parentSessionId ? { parentSessionId: candidate.parentSessionId as string } : {}),
  };
}

/** Saved-session pickers hide read-only sub-agent viewers by default. */
export function isSubagentSession(session: { readonly _meta?: unknown }): boolean {
  return subagentSessionLink(session._meta) !== undefined;
}

export function parseSubagentSessionState(value: unknown, method: string): SubagentSessionState {
  if (!isRecord(value) || typeof value.terminal !== "boolean" || typeof value.revision !== "string") {
    throw new Error(`${method} returned an invalid response`);
  }
  const model = parseModel(value.model);
  const context = parseContext(value.context);
  return {
    terminal: value.terminal,
    revision: value.revision,
    ...(model ? { model } : {}),
    ...(context ? { context } : {}),
  };
}

function parseModel(value: unknown): SubagentSessionModel | undefined {
  if (!isRecord(value) || !nonEmpty(value.provider) || !nonEmpty(value.modelId) || !nonEmpty(value.name)) return undefined;
  return {
    provider: value.provider,
    modelId: value.modelId,
    name: value.name,
    ...(nonEmpty(value.thinking) ? { thinking: value.thinking } : {}),
  };
}

function parseContext(value: unknown): SubagentSessionContext | undefined {
  if (!isRecord(value) || typeof value.contextWindow !== "number" || !(value.contextWindow > 0)) return undefined;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  const tokens = finite(value.tokens) ? value.tokens as number : null;
  const percent = tokens !== null && finite(value.percent) ? value.percent as number : null;
  return { tokens, contextWindow: value.contextWindow, percent };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
