import type { Api, Model } from "@earendil-works/pi-ai";
import { isBlindModelRef, SubagentModelSelectionError, type ResolvedAgentTaskConfig, type SubagentConfig } from "./config.js";
import { isSessionModelUnavailable } from "./model-fallback.js";

export interface SubagentModelRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	/** SDK snapshot excludes providers which are registered but not configured. */
	getAvailable?(): Model<Api>[];
	getApiKeyAndHeaders?(model: Model<Api>): Promise<{ ok?: boolean }>;
}

/** Rank was already determined by the profile/preset intersection. No LLM call. */
export async function selectAvailableAgentModels(
	resolved: ResolvedAgentTaskConfig,
	config: SubagentConfig,
	registry?: SubagentModelRegistry,
	signal?: AbortSignal,
): Promise<ResolvedAgentTaskConfig> {
	if (signal?.aborted) throw new Error("Aborted");
	const needsImages = Boolean(resolved.task.imagePaths?.length) || resolved.task.subagentType === "browser-qa";
	if (!registry && !needsImages) return resolved; // Narrow offline/test callers.
	const candidates = [resolved.task.model, ...resolved.fallbackModels].filter((ref): ref is string => Boolean(ref));
	let registeredAvailable: Set<string> | undefined;
	try {
		if (registry?.getAvailable) {
			registeredAvailable = new Set(registry.getAvailable().map((model) => `${model.provider}/${model.id}`));
		}
	} catch {
		throw new SubagentModelSelectionError(resolved.task.id, "Model runtime availability could not be read.");
	}
	const available: string[] = [];
	for (const ref of candidates) {
		if (signal?.aborted) throw new Error("Aborted");
		if (registeredAvailable && !registeredAvailable.has(ref)) continue;
		if (isSessionModelUnavailable(ref)) continue;
		const slash = ref.indexOf("/");
		if (slash <= 0) continue;
		try {
			const model = registry?.find(ref.slice(0, slash), ref.slice(slash + 1));
			if (!model) continue;
			if (needsImages && (isBlindModelRef(ref, config) || !model.input?.includes("image"))) continue;
			if (registry?.getApiKeyAndHeaders && (await registry.getApiKeyAndHeaders(model)).ok === false) continue;
		} catch {
			// Auth errors may contain sensitive provider details; never echo them.
			continue;
		}
		available.push(ref);
	}
	if (signal?.aborted) throw new Error("Aborted");
	const [model, ...fallbackModels] = available;
	if (!model) throw new SubagentModelSelectionError(resolved.task.id,
		`No configured candidate is available${needsImages ? " with confirmed image support" : ""} in the model runtime.`);
	return { ...resolved, task: { ...resolved.task, model }, fallbackModels };
}
