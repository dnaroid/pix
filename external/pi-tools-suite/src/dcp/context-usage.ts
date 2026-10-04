import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { buildSessionProjection, estimateTokens, getLastAssistantUsage, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { normalizeDcpContextUsage } from "./ui.js";

/** A resolver is scoped to one already-validated full active branch, never a lazy presentation tail. */
export function createDcpContextUsageResolver(fullBranch: readonly unknown[]) {
  const branch = fullBranch as SessionEntry[];
  let boundary = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i]!.type === "context_edit" || branch[i]!.type === "compaction") {
      boundary = i;
      break;
    }
  }
  // A successful response after the latest SDK rewrite is still a native floor.
  // Avoid rebuilding the SDK projection on the ordinary measured-usage path.
  const measured = getLastAssistantUsage(branch.slice(boundary + 1));
  const projection = measured ? undefined : buildSessionProjection(branch);
  const system = projection && getCurrentSystemMessage(projection.messages);
  const rawTokens = projection && (system ? estimateTokens(system) : 0) + projection.messages
    .filter((message) => message.role !== "system")
    .reduce((sum, message) => sum + estimateTokens(message), 0);

  return (observed: Parameters<typeof normalizeDcpContextUsage>[0], messages: any[]) => {
    const usage = normalizeDcpContextUsage(observed);
    // No SDK provenance field exists. Require BOTH the canonical branch proof
    // and exact scalar agreement with its SDK fallback estimate. Unknown hosts,
    // stale samples and measured usage stay conservative, including equal-size
    // native samples. Never infer an estimate just because a number is large.
    if (!usage || rawTokens === undefined || usage.tokens !== rawTokens) {
      return { usage, source: "sdk" as const };
    }
    // Re-estimate the actual DCP projection using the same SDK heuristic. Keep
    // resolved system sections even when the context hook excludes the system.
    const projectedSystem = getCurrentSystemMessage(messages) ?? system;
    const tokens = (projectedSystem ? estimateTokens(projectedSystem) : 0) + messages
      .filter((message) => message.role !== "system")
      .reduce((sum, message) => sum + estimateTokens(message), 0);
    return { usage: { ...usage, tokens, percent: tokens / usage.contextWindow * 100 },
      source: "sdk-fallback-rebased" as const };
  };
}
