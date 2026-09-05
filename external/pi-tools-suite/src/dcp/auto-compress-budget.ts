import { createHash } from "node:crypto";
import {
  AutoCompressionBlockedError,
  createAutoCompressionBlock,
  type AutoCompressionResult,
  type CreateAutoCompressionBlockOptions,
} from "./auto-compress.js";
import { canonicalMessageHash } from "./conversation-index.js";
import { stableMessageKeys } from "./pruner-message-ids.js";
import type { CompressionCandidate } from "./pruner-types.js";
import type { DcpState } from "./state.js";

const rejectedSources = new WeakMap<DcpState, { key: string; error: AutoCompressionBlockedError }>();

/**
 * A source-size estimate is not a net-savings estimate. Try the economical
 * prefix first, then the largest prefix which passed the SAME retention and
 * provider-evidence policy. Both attempts share one deadline. Never relax
 * protection/evidence or claim insufficient gain as a successful compression.
 */
export async function createBudgetedAutoCompressionBlock(
  options: CreateAutoCompressionBlockOptions,
  largestSafeCandidate: CompressionCandidate | null,
): Promise<AutoCompressionResult> {
  options.signal?.throwIfAborted();
  const epoch = options.state.sessionEpoch;
  const key = createHash("sha256").update(JSON.stringify({
    epoch,
    source: options.messages.map(canonicalMessageHash),
    ids: stableMessageKeys(options.messages),
    config: options.config,
    budget: options.requiredGainTokens ?? 0,
    largest: largestSafeCandidate,
  })).digest("hex");
  const rejected = rejectedSources.get(options.state);
  if (rejected?.key === key) throw rejected.error;

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = Math.max(1, options.config.compress.autoCompress.timeoutMs);
  const timer = setTimeout(() => controller.abort(new Error("DCP compression operation deadline exceeded")), timeout);
  const candidates = [options.candidate];
  if (largestSafeCandidate && (
    largestSafeCandidate.startId !== options.candidate.startId ||
    largestSafeCandidate.endId !== options.candidate.endId
  )) candidates.push(largestSafeCandidate);

  try {
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      controller.signal.throwIfAborted();
      if (options.state.sessionEpoch !== epoch) throw new Error("stale_plan: DCP owner changed before budget replan");
      try {
        const result = await createAutoCompressionBlock({
          ...options,
          candidate: candidates[attempt]!,
          signal: controller.signal,
        });
        rejectedSources.delete(options.state);
        return result;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const insufficient = error instanceof AutoCompressionBlockedError &&
          (error.blockedReason === "budget-exhausted" || error.blockedReason === "non-positive-gain");
        if (!insufficient) throw error;
        if (attempt + 1 === candidates.length) {
          rejectedSources.set(options.state, { key, error });
          throw error;
        }
      }
    }
    throw new AutoCompressionBlockedError("budget-exhausted", "No budget-safe compression candidate");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
