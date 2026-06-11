import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export interface SessionTitleConfig {
	enabled: boolean;
	model: string;
	maxInputChars: number;
	maxTitleChars: number;
	maxTokens: number;
	maxRetries: number;
	generationAttempts: number;
	retryDelayMs: number;
	timeoutMs: number;
	terminalTitle: boolean;
	terminalTitlePrefix: string;
	notify: boolean;
	debug: boolean;
}

const DEFAULT_CONFIG: SessionTitleConfig = {
	enabled: true,
	model: "zai/glm-4.5-air",
	maxInputChars: 2000,
	maxTitleChars: 80,
	maxTokens: 32,
	maxRetries: 2,
	generationAttempts: 3,
	retryDelayMs: 3000,
	timeoutMs: 12_000,
	terminalTitle: true,
	terminalTitlePrefix: "pi — ",
	notify: false,
	debug: false,
};

const PIX_CONFIG_FILE = "pix.jsonc";
const SESSION_TITLE_CONFIG_FILE = "session-title.jsonc";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonc(filePath: string): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	try {
		const parsed = parseJsonc(readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function mergeConfig(base: SessionTitleConfig, raw: Record<string, unknown>): SessionTitleConfig {
	const next = { ...base };

	if (typeof raw.enabled === "boolean") next.enabled = raw.enabled;
	const model = readNonEmptyString(raw.modelRef) ?? readNonEmptyString(raw.model);
	if (model) next.model = model;
	if (typeof raw.terminalTitle === "boolean") next.terminalTitle = raw.terminalTitle;
	if (typeof raw.terminalTitlePrefix === "string") next.terminalTitlePrefix = raw.terminalTitlePrefix;
	if (typeof raw.notify === "boolean") next.notify = raw.notify;
	if (typeof raw.debug === "boolean") next.debug = raw.debug;

	if (typeof raw.maxInputChars === "number" && Number.isFinite(raw.maxInputChars)) {
		next.maxInputChars = Math.max(100, Math.floor(raw.maxInputChars));
	}
	if (typeof raw.maxTitleChars === "number" && Number.isFinite(raw.maxTitleChars)) {
		next.maxTitleChars = Math.max(20, Math.floor(raw.maxTitleChars));
	}
	if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)) {
		next.maxTokens = Math.max(8, Math.floor(raw.maxTokens));
	}
	if (typeof raw.maxRetries === "number" && Number.isFinite(raw.maxRetries)) {
		next.maxRetries = Math.max(0, Math.floor(raw.maxRetries));
	}
	if (typeof raw.generationAttempts === "number" && Number.isFinite(raw.generationAttempts)) {
		next.generationAttempts = Math.max(1, Math.floor(raw.generationAttempts));
	}
	if (typeof raw.retryDelayMs === "number" && Number.isFinite(raw.retryDelayMs)) {
		next.retryDelayMs = Math.max(250, Math.floor(raw.retryDelayMs));
	}
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
		next.timeoutMs = Math.max(1000, Math.floor(raw.timeoutMs));
	}

	return next;
}

function readNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readPixSessionTitleConfig(configDir: string): Record<string, unknown> {
	const pixConfig = readJsonc(join(configDir, PIX_CONFIG_FILE));
	return isRecord(pixConfig.sessionTitle) ? pixConfig.sessionTitle : {};
}

function applyEnv(config: SessionTitleConfig): SessionTitleConfig {
	let next = { ...config };
	if (["1", "true", "on", "yes"].includes((process.env.PI_OFFLINE ?? "").trim().toLowerCase())) {
		next.enabled = false;
	}

	const enabled = process.env.PI_SESSION_TITLE_ENABLED;
	if (enabled !== undefined) next.enabled = !["0", "false", "off", "no"].includes(enabled.trim().toLowerCase());

	const model = process.env.PI_SESSION_TITLE_MODEL;
	if (model?.trim()) next.model = model.trim();

	if (process.env.PI_SESSION_TITLE_TERMINAL_TITLE !== undefined) {
		next.terminalTitle = ["1", "true", "on", "yes"].includes(process.env.PI_SESSION_TITLE_TERMINAL_TITLE.trim().toLowerCase());
	}
	if (process.env.PI_SESSION_TITLE_TERMINAL_PREFIX !== undefined) {
		next.terminalTitlePrefix = process.env.PI_SESSION_TITLE_TERMINAL_PREFIX;
	}

	if (process.env.PI_SESSION_TITLE_NOTIFY !== undefined) {
		next.notify = ["1", "true", "on", "yes"].includes(process.env.PI_SESSION_TITLE_NOTIFY.trim().toLowerCase());
	}
	if (process.env.PI_SESSION_TITLE_DEBUG !== undefined) {
		next.debug = ["1", "true", "on", "yes"].includes(process.env.PI_SESSION_TITLE_DEBUG.trim().toLowerCase());
	}

	return next;
}

function findProjectConfig(startDir: string): string | undefined {
	let dir = resolve(startDir);
	const root = parse(dir).root;

	while (true) {
		const candidate = join(dir, ".pi", "session-title.jsonc");
		if (existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

export function loadSessionTitleConfig(projectDir: string): SessionTitleConfig {
	let config = { ...DEFAULT_CONFIG };
	const homeConfigDir = join(homedir(), ".config", "pi");

	config = mergeConfig(config, readPixSessionTitleConfig(homeConfigDir));
	config = mergeConfig(config, readJsonc(join(homeConfigDir, SESSION_TITLE_CONFIG_FILE)));

	const piConfigDir = process.env.PI_CONFIG_DIR;
	if (piConfigDir) {
		config = mergeConfig(config, readPixSessionTitleConfig(piConfigDir));
		config = mergeConfig(config, readJsonc(join(piConfigDir, SESSION_TITLE_CONFIG_FILE)));
	}

	const projectConfig = findProjectConfig(projectDir);
	if (projectConfig) {
		config = mergeConfig(config, readJsonc(projectConfig));
	}

	return applyEnv(config);
}
