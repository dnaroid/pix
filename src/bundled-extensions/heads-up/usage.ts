import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
type ReadonlySessionManager = ExtensionContext["sessionManager"];

export function validObserverUsage(value: unknown): value is Usage {
	if (!value || typeof value !== "object") return false;
	const usage = value as Record<string, unknown>;
	if (!usage.cost || typeof usage.cost !== "object") return false;
	const integer = (number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
	const amount = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0;
	return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => integer(usage[key]))
		&& ["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => amount((usage.cost as Record<string, unknown>)[key]));
}

/** Match existing async-subagent accounting: capture the manager, never resolve the active tab later. */
export function observerUsageRecorder(manager: ReadonlySessionManager) {
	const ownerId = manager.getSessionId();
	const writable = manager as ReadonlySessionManager & { appendUsage?: (kind: string, provider: string, model: string, usage: Usage, note?: string) => unknown };
	return {
		available: () => typeof writable.appendUsage === "function" && manager.getSessionId() === ownerId,
		record: (message: AssistantMessage) => {
			if (typeof writable.appendUsage !== "function" || manager.getSessionId() !== ownerId) throw new Error("observer usage owner changed");
			if (!message.provider || !message.model || !validObserverUsage(message.usage)) throw new Error("invalid observer usage");
			writable.appendUsage("heads-up", message.provider, message.model, message.usage, "observer check");
		},
	};
}
