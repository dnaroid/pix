import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { getPiToolsSuiteUserConfigPath } from "../config.js";
import type { Strictness } from "./detect.js";

export interface CommentCheckerConfig {
	enabled: boolean;
	strictness: Strictness;
}

const DEFAULT_STRICTNESS: Strictness = "balanced";
const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

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

function normalizeStrictness(value: unknown, fallback: Strictness): Strictness {
	if (value === "conservative" || value === "balanced" || value === "aggressive") return value;
	return fallback;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
}

let cachedConfig: CommentCheckerConfig | undefined;

/**
 * Load the `commentChecker` section from the same layered config files as the
 * rest of the suite (user shared config, $PI_CONFIG_DIR, nearest project
 * `.pi/pi-tools-suite.jsonc`), then apply env overrides.
 *
 * Module disabling is handled by the top-level `disabledModules` loader in
 * `config.ts`; this loader only reads the per-module `commentChecker` section
 * (enabled toggle + strictness).
 *
 * Cached after the first read for the lifetime of the process.
 */
export function loadCommentCheckerConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env, homeDir: string = env.HOME ?? process.env.HOME ?? ""): CommentCheckerConfig {
	if (cachedConfig) return cachedConfig;

	let enabled = true;
	let strictness: Strictness = DEFAULT_STRICTNESS;

	const layers: string[] = [getPiToolsSuiteUserConfigPath(homeDir)];
	if (env.PI_CONFIG_DIR) layers.push(join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const projectConfig = findProjectConfig(cwd);
	if (projectConfig) layers.push(projectConfig);

	for (const filePath of layers) {
		const root = readJsonc(filePath);
		const section = root.commentChecker;
		if (!isRecord(section)) continue;
		if (typeof section.enabled === "boolean") enabled = section.enabled;
		if (section.strictness !== undefined) strictness = normalizeStrictness(section.strictness, strictness);
	}

	const envEnabled = boolFromEnv(env.PI_COMMENT_CHECKER_ENABLED);
	if (envEnabled !== undefined) enabled = envEnabled;
	if (env.PI_COMMENT_CHECKER_STRICTNESS) strictness = normalizeStrictness(env.PI_COMMENT_CHECKER_STRICTNESS, strictness);

	cachedConfig = { enabled, strictness };
	return cachedConfig;
}

export function __resetCommentCheckerConfigCache(): void {
	cachedConfig = undefined;
}
