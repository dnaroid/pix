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
const FINALIZATION_GRACE_MS = 1_000;

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
    allowPartialGain: options.allowPartialGain === true,
    largest: largestSafeCandidate,
  })).digest("hex");
  const rejected = rejectedSources.get(options.state);
  if (rejected?.key === key) throw rejected.error;

  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = Math.max(1, options.config.compress.autoCompress.timeoutMs);
  // generateModelSummary owns the configured summarizer deadline and can
  // deliberately recover from it with the deterministic extractive fallback.
  // Keep a small bounded tail for that fallback and durable publication;
  // aborting at exactly `timeout` races the fallback and turns every slow model
  // into a generic preparation failure instead of a successful compression.
  const operationDeadline = timeout + FINALIZATION_GRACE_MS;
  let internalDeadlineExceeded = false;
  const timer = setTimeout(() => {
    internalDeadlineExceeded = true;
    controller.abort(new Error("DCP compression operation deadline exceeded"));
  }, operationDeadline);
  // A parent cancellation is passed through untouched and never becomes a
  // blocked reason. Only the internal whole-operation deadline is classified:
  // otherwise callers surface a generic preparation failure and keep retrying
  // an operation that can no longer make progress within its budget.
  const operationAbortError = (): unknown => {
    if (options.signal?.aborted) {
      return options.signal.reason ?? controller.signal.reason ?? new Error("DCP compression operation aborted");
    }
    if (internalDeadlineExceeded) {
      return new AutoCompressionBlockedError(
        "summarizer-unavailable",
        `Auto-compression preparation exceeded its whole-operation deadline of ${operationDeadline}ms ` +
          "(DCP compression operation deadline exceeded) and was stopped without publishing state",
      );
    }
    return controller.signal.reason ?? new Error("DCP compression operation aborted");
  };
  const candidates = [options.candidate];
  if (largestSafeCandidate && (
    largestSafeCandidate.startId !== options.candidate.startId ||
    largestSafeCandidate.endId !== options.candidate.endId
  )) candidates.push(largestSafeCandidate);

  try {
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      if (controller.signal.aborted) throw operationAbortError();
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
        if (controller.signal.aborted) throw operationAbortError();
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
