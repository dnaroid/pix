// Council configuration read directly from pi-tools-suite.jsonc layers.
// Layer order mirrors the suite loader: user (~/.config/pi), $PI_CONFIG_DIR,
// nearest project .pi/pi-tools-suite.jsonc. Only frontierModels and the
// brainstorm key are interpreted here. test/brainstorm/council-config.test.ts
// keeps the frontier roster in parity with loadPiToolsSuiteConfig.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseJsonc } from "./jsonc.mjs";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_OUTPUT_DIR = ".pi/brainstorms";
/** Mirror of DEFAULT_FRONTIER_MODELS in async-subagents/core/frontier-models.ts (parity-tested). */
export const DEFAULT_FRONTIER_MODELS = Object.freeze(["openai-codex/gpt-6-astra", "zai/glm-5.3", "anthropic/claude-opus-5-5"]);
/** Mirror of the generated default brainstorm.thinkingOverrides. */
export const DEFAULT_THINKING_OVERRIDES = Object.freeze({ "zai/glm-5.3": "max" });
const defaultFrontier = () => DEFAULT_FRONTIER_MODELS.map((model) => ({ model, enabled: true }));
export const PUBLISH_DIR = "docs/brainstorms";
const MODEL_REF = /^[^\s/*?]+\/[^\s*?]+$/;

export class ConfigError extends Error {
	constructor(message) { super(message); this.code = 2; }
}

function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readLayer(file) {
	if (!existsSync(file)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(file, "utf8"));
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		// Same as the suite loader: an unreadable layer contributes nothing.
		return undefined;
	}
}

function findProjectConfig(startDir) {
	let dir = path.resolve(startDir);
	while (true) {
		const candidate = path.join(dir, ".pi", "pi-tools-suite.jsonc");
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function configLayerPaths({ cwd, env = process.env, homeDir } = {}) {
	const home = homeDir ?? (env.HOME?.trim() || homedir());
	const paths = [path.join(home, ".config", "pi", "pi-tools-suite.jsonc")];
	if (env.PI_CONFIG_DIR) paths.push(path.join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const project = findProjectConfig(cwd ?? process.cwd());
	if (project) paths.push(project);
	return paths;
}

function providerOf(ref) {
	const trimmed = typeof ref === "string" ? ref.trim() : "";
	if (!trimmed || /[\s*]/.test(trimmed)) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return trimmed.slice(0, slash).toLowerCase();
}

/** Ordered frontier entries; string and object forms, as in the suite. */
export function normalizeFrontier(raw) {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set();
	const entries = [];
	for (const item of raw) {
		const entry = typeof item === "string" ? { model: item } : item;
		if (!isRecord(entry) || typeof entry.model !== "string") continue;
		const model = entry.model.trim();
		if (!providerOf(model) || seen.has(model)) continue;
		seen.add(model);
		entries.push({ model, enabled: entry.enabled !== false });
	}
	return entries;
}

export function rosterFromFrontier(entries) {
	return [...new Set(entries.filter((entry) => entry.enabled).map((entry) => entry.model))].slice(0, 6);
}

export function normalizedModelId(ref) {
	const trimmed = ref?.trim().toLowerCase();
	if (!trimmed) return undefined;
	return trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/^~+/, "") || undefined;
}

export function normalizeOutputDir(value) {
	if (typeof value !== "string" || !value.trim() || value.length > 200) throw new ConfigError("brainstorm.outputDir must be a non-empty project-relative path.");
	const normalized = path.posix.normalize(value.trim().replaceAll("\\", "/")).replace(/\/+$/, "");
	if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(value) || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new ConfigError("brainstorm.outputDir must stay inside the project (relative, no '..').");
	}
	return normalized;
}

function assertModels(models, label = "brainstorm.models") {
	if (!Array.isArray(models) || models.length < 2 || models.length > 6 ||
		models.some((model) => typeof model !== "string" || !MODEL_REF.test(model)) || new Set(models).size !== models.length) {
		throw new ConfigError(`${label} must contain 2–6 distinct exact provider/model references (no wildcards).`);
	}
}

function assertThinking(value, label) {
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value)) throw new ConfigError(`Invalid ${label} level.`);
}

export function defaultCouncilConfig() {
	return { models: [], modelsExplicit: false, thinking: "high", thinkingOverrides: { ...DEFAULT_THINKING_OVERRIDES }, timeoutSeconds: 600, outputDir: DEFAULT_OUTPUT_DIR };
}

/** Merge one layer's brainstorm key; frontier re-derives a non-explicit roster. */
export function mergeCouncilLayer(base, raw, frontier) {
	if (raw !== undefined && !isRecord(raw)) throw new ConfigError("brainstorm must be an object.");
	const value = raw ?? {};
	let { models, modelsExplicit } = base;
	if (value.models === null) { modelsExplicit = false; models = rosterFromFrontier(frontier); }
	else if (value.models !== undefined) { assertModels(value.models); models = [...value.models]; modelsExplicit = true; }
	else if (!modelsExplicit) models = rosterFromFrontier(frontier);
	if (modelsExplicit) assertModels(models);

	const thinking = value.thinking === undefined ? base.thinking : value.thinking;
	assertThinking(thinking, "brainstorm.thinking");

	const thinkingOverrides = { ...base.thinkingOverrides };
	if (value.thinkingOverrides === null) for (const key of Object.keys(thinkingOverrides)) delete thinkingOverrides[key];
	else if (value.thinkingOverrides !== undefined) {
		if (!isRecord(value.thinkingOverrides)) throw new ConfigError("brainstorm.thinkingOverrides must map provider/model to a thinking level.");
		for (const [key, level] of Object.entries(value.thinkingOverrides)) {
			if (level === null) { delete thinkingOverrides[key]; continue; }
			assertThinking(level, `brainstorm.thinkingOverrides["${key}"]`);
			thinkingOverrides[key] = level;
		}
	}

	const timeoutSeconds = value.timeoutSeconds === undefined ? base.timeoutSeconds : value.timeoutSeconds;
	if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) {
		throw new ConfigError("brainstorm.timeoutSeconds must be an integer from 30 to 1800.");
	}
	const outputDir = normalizeOutputDir(value.outputDir === undefined ? base.outputDir : value.outputDir);
	let quorum = value.quorum === undefined ? base.quorum : value.quorum === null ? undefined : value.quorum;
	if (quorum !== undefined && (typeof quorum !== "number" || !Number.isInteger(quorum) || quorum < 2 || quorum > 6)) {
		throw new ConfigError("brainstorm.quorum must be an integer from 2 to 6.");
	}
	const result = { models, modelsExplicit, thinking, thinkingOverrides, timeoutSeconds, outputDir };
	if (quorum !== undefined) result.quorum = quorum;
	return result;
}

/**
 * Resolve the council configuration. Like the suite loader, the frontier list
 * starts from the built-in defaults and `frontierModels: null` restores them.
 */
export function loadCouncilConfig(options = {}) {
	let frontier = defaultFrontier();
	let config = { ...defaultCouncilConfig(), models: rosterFromFrontier(frontier) };
	const sources = [];
	for (const file of configLayerPaths(options)) {
		const layer = readLayer(file);
		if (!layer) continue;
		sources.push(file);
		if (Object.prototype.hasOwnProperty.call(layer, "frontierModels")) {
			frontier = layer.frontierModels === null ? defaultFrontier() : normalizeFrontier(layer.frontierModels) ?? frontier;
		}
		config = mergeCouncilLayer(config, layer.brainstorm, frontier);
	}
	return { ...config, sources };
}

/** Run-only roster: provider/model:effort entries, never persisted. */
export function parseRunModels(value) {
	const entries = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(entries) || entries.length < 2 || entries.length > 6) {
		throw new ConfigError("--models must contain 2–6 distinct exact provider/model:effort entries.");
	}
	const models = [];
	const thinkingOverrides = {};
	for (const entry of entries) {
		if (typeof entry !== "string") throw new ConfigError("Each models entry must be provider/model:effort.");
		const separator = entry.lastIndexOf(":");
		if (separator < 0) throw new ConfigError("Each models entry must include :effort (off|minimal|low|medium|high|xhigh|max).");
		const model = entry.slice(0, separator), thinking = entry.slice(separator + 1);
		assertThinking(thinking, "models effort");
		models.push(model);
		thinkingOverrides[model] = thinking;
	}
	assertModels(models, "--models");
	return { models, thinkingOverrides };
}

export function applyRunModels(config, value) {
	const { models, thinkingOverrides } = parseRunModels(value);
	return { ...config, models, modelsExplicit: true, thinkingOverrides: { ...config.thinkingOverrides, ...thinkingOverrides } };
}

export function resolvedQuorum(config) {
	return config.quorum ?? Math.max(2, config.models.length - 1);
}

/** Exact ref, then bare model id, then the default level. */
export function thinkingForModel(config, model) {
	const overrides = config.thinkingOverrides ?? {};
	if (overrides[model]) return overrides[model];
	const id = normalizedModelId(model);
	const match = Object.entries(overrides).find(([key]) => normalizedModelId(key) === id);
	return match ? match[1] : config.thinking;
}

export function assertRunnable(config) {
	if (config.models.length < 2) {
		throw new ConfigError("The council needs at least 2 models: enable 2+ frontierModels or set brainstorm.models in pi-tools-suite.jsonc, or pass --models.");
	}
	assertModels(config.models);
	if (resolvedQuorum(config) > config.models.length) throw new ConfigError("brainstorm.quorum cannot exceed the roster size.");
}
