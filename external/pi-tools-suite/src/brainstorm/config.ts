import path from "node:path";
import { DEFAULT_FRONTIER_MODELS, normalizedModelId, type FrontierModelEntry } from "../async-subagents/core/frontier-models.js";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type BrainstormThinking = typeof THINKING_LEVELS[number];

/** Council protocol stays out of the project knowledge base unless explicitly published. */
export const DEFAULT_BRAINSTORM_OUTPUT_DIR = ".pi/brainstorms";
/** Finalized proposals are optionally copied here; also accepted as a legacy run root. */
export const BRAINSTORM_PUBLISH_DIR = "docs/brainstorms";

export interface BrainstormConfig {
	/** Resolved ordered roster: explicit brainstorm.models, otherwise enabled frontierModels. */
	models: string[];
	/** True when the roster came from an explicit config or run override rather than frontierModels. */
	modelsExplicit: boolean;
	/** Default participant thinking level. */
	thinking: string;
	/** Per-model thinking level (exact provider/model or bare model id). */
	thinkingOverrides: Record<string, string>;
	timeoutSeconds: number;
	/** Project-relative run root. */
	outputDir: string;
	/** Minimum successful participants per round; default max(2, roster − 1). */
	quorum?: number;
}

/** Loose input accepted by programmatic callers and older persisted snapshots. */
export type BrainstormConfigInput = Partial<BrainstormConfig> & { models: string[] };

const MODEL_REF = /^[^\s/*?]+\/[^\s*?]+$/;
export const DEFAULT_THINKING_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({ "zai/glm-5.3": "max" });

/** Enabled frontier entries in preference order; role allow-lists target sub-agent roles, not the council. */
export function brainstormModelsFromFrontier(entries: readonly FrontierModelEntry[]): string[] {
	return [...new Set(entries.filter((entry) => entry.enabled !== false).map((entry) => entry.model))].slice(0, 6);
}

export function defaultBrainstormConfig(frontier: readonly FrontierModelEntry[] = DEFAULT_FRONTIER_MODELS): BrainstormConfig {
	return {
		models: brainstormModelsFromFrontier(frontier),
		modelsExplicit: false,
		thinking: "high",
		thinkingOverrides: { ...DEFAULT_THINKING_OVERRIDES },
		timeoutSeconds: 600,
		outputDir: DEFAULT_BRAINSTORM_OUTPUT_DIR,
	};
}

function assertModels(models: unknown): asserts models is string[] {
	if (!Array.isArray(models) || models.length < 2 || models.length > 6 ||
		models.some((model) => typeof model !== "string" || !MODEL_REF.test(model)) ||
		new Set(models).size !== models.length) {
		throw new Error("brainstorm.models must contain 2–6 distinct exact provider/model references (no wildcards).");
	}
}

function assertThinking(value: unknown, label = "brainstorm.thinking"): asserts value is string {
	if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) throw new Error(`Invalid ${label} level.`);
}

/** A run roster always specifies effort, avoiding inherited expensive per-model defaults. */
export function parseRunModels(value: unknown): { models: string[]; thinkingOverrides: Record<string, string> } {
	if (!Array.isArray(value) || value.length < 2 || value.length > 6) {
		throw new Error("models must contain 2–6 distinct exact provider/model:effort entries.");
	}
	const models: string[] = [];
	const thinkingOverrides: Record<string, string> = {};
	for (const entry of value) {
		if (typeof entry !== "string") throw new Error("Each models entry must be provider/model:effort.");
		const separator = entry.lastIndexOf(":");
		if (separator < 0) throw new Error("Each models entry must include :effort (off|minimal|low|medium|high|xhigh|max).");
		const model = entry.slice(0, separator), thinking = entry.slice(separator + 1);
		assertThinking(thinking, "models effort");
		models.push(model);
		thinkingOverrides[model] = thinking;
	}
	assertModels(models);
	return { models, thinkingOverrides };
}

/** Copy configuration; never persist a one-run override back to user/project settings. */
export function configForRun(base: BrainstormConfig, models?: unknown): BrainstormConfig {
	const result = mergeBrainstormConfig(base, models === undefined ? undefined : parseRunModels(models));
	assertRunnableConfig(result);
	return result;
}

export function normalizeOutputDir(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("brainstorm.outputDir must be a non-empty project-relative path.");
	const normalized = path.posix.normalize(value.trim().replaceAll("\\", "/")).replace(/\/+$/, "");
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new Error("brainstorm.outputDir must stay inside the project (relative, no '..').");
	}
	return normalized;
}

export function resolvedQuorum(config: Pick<BrainstormConfig, "models" | "quorum">): number {
	return config.quorum ?? Math.max(2, config.models.length - 1);
}

/** Per-participant thinking: exact ref, then bare model id, then the default. */
export function thinkingForModel(config: Pick<BrainstormConfig, "thinking" | "thinkingOverrides">, model: string): string {
	const overrides = config.thinkingOverrides ?? {};
	if (overrides[model]) return overrides[model]!;
	const id = normalizedModelId(model);
	const match = Object.entries(overrides).find(([key]) => normalizedModelId(key) === id);
	return match ? match[1] : config.thinking;
}

/**
 * Merge one config layer. `models: null` (or an absent roster) keeps deriving the
 * roster from frontierModels; pass `frontier` to re-derive after frontier changes.
 */
export function mergeBrainstormConfig(base: BrainstormConfig | BrainstormConfigInput, raw: unknown, frontier?: readonly FrontierModelEntry[]): BrainstormConfig {
	const start: BrainstormConfig = {
		...defaultBrainstormConfig(),
		...base,
		models: [...base.models],
		modelsExplicit: base.modelsExplicit ?? true,
		thinkingOverrides: { ...(base.thinkingOverrides ?? DEFAULT_THINKING_OVERRIDES) },
	};
	if (start.quorum === undefined) delete start.quorum;
	if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("brainstorm must be an object.");
	const value = (raw ?? {}) as Record<string, unknown>;

	let models = start.models, modelsExplicit = start.modelsExplicit;
	if (value.models === null) { modelsExplicit = false; models = brainstormModelsFromFrontier(frontier ?? DEFAULT_FRONTIER_MODELS); }
	else if (value.models !== undefined) { assertModels(value.models); models = [...value.models]; modelsExplicit = true; }
	else if (!modelsExplicit && frontier) models = brainstormModelsFromFrontier(frontier);
	if (modelsExplicit || models.length >= 2) assertModels(models);

	const thinking = value.thinking === undefined ? start.thinking : value.thinking;
	assertThinking(thinking);

	const thinkingOverrides = { ...start.thinkingOverrides };
	if (value.thinkingOverrides !== undefined) {
		if (value.thinkingOverrides === null) for (const key of Object.keys(thinkingOverrides)) delete thinkingOverrides[key];
		else if (typeof value.thinkingOverrides !== "object" || Array.isArray(value.thinkingOverrides)) throw new Error("brainstorm.thinkingOverrides must map provider/model to a thinking level.");
		else for (const [key, level] of Object.entries(value.thinkingOverrides as Record<string, unknown>)) {
			if (level === null) { delete thinkingOverrides[key]; continue; }
			assertThinking(level, `brainstorm.thinkingOverrides["${key}"]`);
			thinkingOverrides[key] = level;
		}
	}

	const timeoutSeconds = value.timeoutSeconds === undefined ? start.timeoutSeconds : value.timeoutSeconds;
	if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) {
		throw new Error("brainstorm.timeoutSeconds must be an integer from 30 to 1800.");
	}
	const outputDir = value.outputDir === undefined ? normalizeOutputDir(start.outputDir) : normalizeOutputDir(value.outputDir);

	let quorum = value.quorum === undefined ? start.quorum : value.quorum === null ? undefined : value.quorum;
	if (quorum !== undefined && (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum < 2 || quorum > 6)) {
		throw new Error("brainstorm.quorum must be an integer from 2 to 6.");
	}
	const result: BrainstormConfig = { models, modelsExplicit, thinking, thinkingOverrides, timeoutSeconds, outputDir };
	if (quorum !== undefined) result.quorum = quorum as number;
	return result;
}

/** Runtime validation before paid work: a usable roster and a reachable quorum. */
export function assertRunnableConfig(config: BrainstormConfig): void {
	if (config.models.length < 2) {
		throw new Error("brainstorm needs at least 2 models: enable 2+ frontierModels or set brainstorm.models explicitly.");
	}
	assertModels(config.models);
	if (resolvedQuorum(config) > config.models.length) throw new Error("brainstorm.quorum cannot exceed the roster size.");
}
