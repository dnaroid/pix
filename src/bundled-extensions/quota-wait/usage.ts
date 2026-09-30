import { modelUsageDescriptor, queryModelUsageStatus } from "../../app/model/model-usage-status.js";
import type { SessionModel } from "../../app/types.js";
import type { QuotaCheck } from "../../app/session/quota-wait.js";

/** Always queries the provider: cached status-bar samples cannot authorize a resume. */
export async function checkQuota(model: SessionModel | undefined, thinkingLevel?: string): Promise<QuotaCheck> {
	const descriptor = modelUsageDescriptor(model, thinkingLevel);
	if (!descriptor) return { kind: "unknown" };
	try {
		const status = await queryModelUsageStatus(descriptor, { freshOnly: true });
		if (!status || status.stale || status.modelKey !== descriptor.modelKey) return { kind: "unknown" };
		const windows = (["hourly", "weekly"] as const).flatMap((window) => {
			const value = status[window];
			return value ? [{ window, value }] : [];
		});
		const exhausted = windows.filter(({ value }) => value.remainingPercent <= 0);
		// Both limits must permit a request; the later binding reset wins.
		exhausted.sort((a, b) => b.value.resetAt - a.value.resetAt);
		const binding = exhausted[0];
		if (binding) return { kind: "exhausted", window: binding.window,
			...(Number.isFinite(binding.value.resetAt) && binding.value.resetAt > 0 ? { resetAt: binding.value.resetAt } : {}) };
		return windows.length ? { kind: "available" } : { kind: "unknown" };
	} catch { return { kind: "failed" }; }
}
