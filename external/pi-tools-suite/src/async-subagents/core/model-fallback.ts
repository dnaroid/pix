import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentCompletionHandler } from "./types.js";

const exhaustedModels = new Set<string>();
const exhaustedProviders = new Set<string>();
const fallbackByModel = new Map<string, string>();
const fallbackByProvider = new Map<string, string>();
const ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED_MARKER = "antigravity_all_accounts_exhausted";

export interface SessionModelFallbackSelection {
	model: string;
	fellBack: boolean;
	fromModel?: string;
}

export function selectSessionModelWithFallback(model: string | undefined, fallbackModels: string[] = []): SessionModelFallbackSelection | undefined {
	if (!model) return undefined;
	const chain = normalizeFallbackChain(model, fallbackModels);
	let current = model;
	const seen = new Set<string>();

	while (isSessionModelUnavailable(current) && !seen.has(current)) {
		seen.add(current);
		const mapped = fallbackByModel.get(current) ?? fallbackByProvider.get(modelProvider(current));
		if (mapped && chain.includes(mapped) && !seen.has(mapped) && !isSessionModelUnavailable(mapped)) {
			current = mapped;
			continue;
		}

		const next = firstAvailableFallback(current, chain);
		if (!next) break;
		fallbackByModel.set(current, next);
		current = next;
	}

	return current === model
		? { model, fellBack: false }
		: { model: current, fellBack: true, fromModel: model };
}

export function nextFallbackModel(failedModel: string | undefined, fallbackModels: string[] = []): string | undefined {
	if (!failedModel) return undefined;
	const chain = normalizeFallbackChain(failedModel, fallbackModels);
	return firstAvailableFallback(failedModel, chain);
}

export function rememberSessionModelFallback(failedModel: string | undefined, fallbackModel: string | undefined): void {
	if (!failedModel) return;
	exhaustedModels.add(failedModel);
	const provider = modelProvider(failedModel);
	if (shouldRememberProviderExhaustion(provider)) exhaustedProviders.add(provider);
	if (fallbackModel && fallbackModel !== failedModel) {
		fallbackByModel.set(failedModel, fallbackModel);
		if (shouldRememberProviderExhaustion(provider) && modelProvider(fallbackModel) !== provider) fallbackByProvider.set(provider, fallbackModel);
	}
}

export function isQuotaLimitCompletion(completion: Parameters<AgentCompletionHandler>[0], model?: string): boolean {
	if (completion.exitCode === 0 || completion.state.status === "stopped") return false;
	const text = [
		readIfExists(path.join(completion.agentDir, "result.md")),
		readIfExists(path.join(completion.agentDir, "stderr.log")),
		readRecentEvents(completion.agentDir),
	].filter(Boolean).join("\n").toLowerCase();
	if (!text.trim()) return false;
	if (modelProvider(model ?? "") === "antigravity") return text.includes(ANTIGRAVITY_ALL_ACCOUNTS_EXHAUSTED_MARKER);

	return [
		/\b429\b/,
		/too many requests/,
		/rate[-_\s]?limit(?:ed|s| reached| exceeded)?/,
		/quota(?:\s+|[-_])?(?:exceeded|exhausted|limit|reached)/,
		/insufficient[_\s-]?quota/,
		/resource[_\s-]?exhausted/,
		/usage(?:\s+|[-_])?limit(?:\s+|[-_])?(?:exceeded|reached)/,
		/billing(?:\s+|[-_])?(?:hard\s+)?limit/,
	].some((pattern) => pattern.test(text));
}

export function resetSessionModelFallbacks(): void {
	exhaustedModels.clear();
	exhaustedProviders.clear();
	fallbackByModel.clear();
	fallbackByProvider.clear();
}

function normalizeFallbackChain(model: string, fallbackModels: string[]): string[] {
	const seen = new Set<string>([model]);
	const chain: string[] = [];
	for (const fallback of fallbackModels) {
		const trimmed = fallback.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		chain.push(trimmed);
	}
	return chain;
}

function firstAvailableFallback(failedModel: string, fallbackModels: string[]): string | undefined {
	const failedIndex = fallbackModels.indexOf(failedModel);
	const candidates = failedIndex >= 0 ? fallbackModels.slice(failedIndex + 1) : fallbackModels;
	const failedProvider = modelProvider(failedModel);
	return candidates.find((candidate) => modelProvider(candidate) !== failedProvider && !isSessionModelUnavailable(candidate));
}

function isSessionModelUnavailable(model: string): boolean {
	return exhaustedModels.has(model) || exhaustedProviders.has(modelProvider(model));
}

function shouldRememberProviderExhaustion(provider: string): boolean {
	return !!provider && provider !== "antigravity";
}

function modelProvider(model: string): string {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : model;
}

function readIfExists(file: string): string {
	try {
		return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
	} catch {
		return "";
	}
}

function readRecentEvents(agentDir: string): string {
	const text = readIfExists(path.join(agentDir, "events.jsonl"));
	if (!text) return "";
	const lines = text.split("\n").filter(Boolean);
	return lines.slice(-20).join("\n");
}
