import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "./default-pi-tools-suite-config.js";

export interface TelegramMirrorConfig {
	enabled: boolean;
	botToken: string;
	chatId: number;
}

export interface PiToolsSuiteConfig {
	enabled: boolean;
	disabledModules: string[];
	todoThinking: boolean;
	telegramMirror?: TelegramMirrorConfig;
}

type MutableConfig = {
	enabled: boolean;
	disabledModules: Set<string>;
	todoThinking: boolean;
	telegramMirror: TelegramMirrorConfig | undefined;
};

type Env = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

const DISABLED_LIST_KEYS = ["disabledModules", "disabledExtensions"];
const ENABLED_LIST_KEYS = ["enabledModules", "enabledExtensions"];
const MODULE_MAP_KEYS = ["modules", "extensions"];
const DEFAULT_DISABLED_MODULES = new Set<string>();

export function getPiToolsSuiteUserConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
}

function ensureUserConfig(filePath: string): void {
	if (existsSync(filePath)) return;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC, { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
		// Config creation is best-effort; loading should still work in read-only homes.
	}
}

export function ensurePiToolsSuiteUserConfig(_moduleNames: readonly string[] = [], options: { homeDir?: string } = {}): string {
	const filePath = getPiToolsSuiteUserConfigPath(options.homeDir);
	ensureUserConfig(filePath);
	return filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTelegramMirror(raw: unknown): TelegramMirrorConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const botToken = typeof raw.botToken === "string" ? raw.botToken.trim() : "";
	if (!botToken) return undefined;

	let chatId: number | undefined;
	if (typeof raw.chatId === "number" && Number.isFinite(raw.chatId) && Number.isInteger(raw.chatId)) {
		chatId = raw.chatId;
	} else if (typeof raw.chatId === "string") {
		const trimmed = raw.chatId.trim();
		if (/^-?\d+$/.test(trimmed)) {
			const parsed = Number(trimmed);
			if (Number.isFinite(parsed) && Number.isInteger(parsed)) chatId = parsed;
		}
	}
	if (chatId === undefined) return undefined;

	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
	return { enabled, botToken, chatId };
}

function boolFromEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
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

function splitNameList(value: unknown): string[] {
	if (typeof value === "string") {
		if (FALSE_VALUES.has(value.trim().toLowerCase())) return [];
		return value
			.split(/[\s,;]+/g)
			.map((item) => item.trim())
			.filter(Boolean);
	}
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function canonicalModuleName(name: string, knownModules: ReadonlySet<string>): string | undefined {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return undefined;
	return knownModules.has(normalized) ? normalized : undefined;
}

function addDisabled(config: MutableConfig, value: unknown, knownModules: ReadonlySet<string>): void {
	const names = splitNameList(value);
	if (names.some((name) => name === "*" || name.toLowerCase() === "all")) {
		for (const moduleName of knownModules) config.disabledModules.add(moduleName);
		return;
	}
	for (const name of names) {
		const moduleName = canonicalModuleName(name, knownModules);
		if (moduleName) config.disabledModules.add(moduleName);
	}
}

function removeDisabled(config: MutableConfig, value: unknown, knownModules: ReadonlySet<string>): void {
	for (const name of splitNameList(value)) {
		const moduleName = canonicalModuleName(name, knownModules);
		if (moduleName) config.disabledModules.delete(moduleName);
	}
}

function mergeConfigLayer(config: MutableConfig, raw: Record<string, unknown>, knownModules: ReadonlySet<string>): MutableConfig {
	if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
	if (typeof raw.todoThinking === "boolean") config.todoThinking = raw.todoThinking;

	for (const key of DISABLED_LIST_KEYS) addDisabled(config, raw[key], knownModules);
	for (const key of ENABLED_LIST_KEYS) removeDisabled(config, raw[key], knownModules);

	for (const key of MODULE_MAP_KEYS) {
		const modules = raw[key];
		if (!isRecord(modules)) continue;
		for (const [name, value] of Object.entries(modules)) {
			const moduleName = canonicalModuleName(name, knownModules);
			if (!moduleName || typeof value !== "boolean") continue;
			if (value) config.disabledModules.delete(moduleName);
			else config.disabledModules.add(moduleName);
		}
	}

	const telegramMirror = normalizeTelegramMirror(raw.telegramMirror);
	if (telegramMirror) config.telegramMirror = telegramMirror;

	return config;
}

function findProjectConfig(startDir: string): string | undefined {
	let dir = resolve(startDir);
	const root = parse(dir).root;

	while (true) {
		const candidate = join(dir, ".pi", "pi-tools-suite.jsonc");
		if (existsSync(candidate)) return candidate;
		if (dir === root) return undefined;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function applyEnv(config: MutableConfig, env: Env, knownModules: ReadonlySet<string>): MutableConfig {
	const enabled = boolFromEnv(env.PI_TOOLS_SUITE_ENABLED);
	if (enabled !== undefined) config.enabled = enabled;

	const disabled = boolFromEnv(env.PI_TOOLS_SUITE_DISABLED);
	if (disabled === true) config.enabled = false;
	else if (disabled === false && enabled === undefined) config.enabled = true;

	addDisabled(config, env.PI_TOOLS_SUITE_DISABLED_MODULES, knownModules);
	addDisabled(config, env.PI_TOOLS_SUITE_DISABLED_EXTENSIONS, knownModules);

	const todoThinking = boolFromEnv(env.PI_TOOLS_SUITE_TODO_THINKING);
	if (todoThinking !== undefined) config.todoThinking = todoThinking;

	return config;
}

export function loadPiToolsSuiteConfig(moduleNames: readonly string[], options: { cwd?: string; env?: Env; homeDir?: string } = {}): PiToolsSuiteConfig {
	const env = options.env ?? process.env;
	const knownModules = new Set(moduleNames.map((name) => name.toLowerCase()));
	const config: MutableConfig = {
		enabled: true,
		disabledModules: new Set([...DEFAULT_DISABLED_MODULES].filter((name) => knownModules.has(name))),
		todoThinking: false,
		telegramMirror: undefined,
	};
	const userConfigPath = getPiToolsSuiteUserConfigPath(options.homeDir);

	ensureUserConfig(userConfigPath);
	mergeConfigLayer(config, readJsonc(userConfigPath), knownModules);

	const piConfigDir = env.PI_CONFIG_DIR;
	if (piConfigDir) mergeConfigLayer(config, readJsonc(join(piConfigDir, "pi-tools-suite.jsonc")), knownModules);

	const projectConfig = findProjectConfig(options.cwd ?? process.cwd());
	if (projectConfig) mergeConfigLayer(config, readJsonc(projectConfig), knownModules);

	applyEnv(config, env, knownModules);

	return {
		enabled: config.enabled,
		disabledModules: [...config.disabledModules].sort(),
		todoThinking: config.todoThinking,
		...(config.telegramMirror ? { telegramMirror: config.telegramMirror } : {}),
	};
}

/**
 * Load only the telegram-mirror section from the pi-tools-suite config layers.
 * Returns undefined when the section is missing or invalid (botToken empty /
 * chatId non-integer).
 */
export function loadTelegramMirrorConfig(options: { cwd?: string; env?: Env; homeDir?: string } = {}): TelegramMirrorConfig | undefined {
	return loadPiToolsSuiteConfig([], options).telegramMirror;
}
