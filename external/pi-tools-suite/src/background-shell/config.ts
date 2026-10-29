import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import { getPiToolsSuiteUserConfigPath } from "../config.js";
import { DEFAULT_MAX_JOBS_PER_SESSION } from "./manager.js";

export type BackgroundShellNotifyMode = "context" | "ui-only" | "off";

export interface BackgroundShellConfig {
	notifyOnExit: BackgroundShellNotifyMode;
	maxJobsPerSession: number;
}

const NOTIFY_MODES = new Set<BackgroundShellNotifyMode>(["context", "ui-only", "off"]);

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

function notifyMode(value: unknown): BackgroundShellNotifyMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase() as BackgroundShellNotifyMode;
	return NOTIFY_MODES.has(normalized) ? normalized : undefined;
}

function jobLimit(value: unknown): number | undefined {
	const number = typeof value === "string" ? Number(value.trim()) : value;
	return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= 64 ? number : undefined;
}

/** Layered config: user → $PI_CONFIG_DIR → nearest project `.pi/pi-tools-suite.jsonc` → env. */
export function loadBackgroundShellConfig(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = env.HOME ?? process.env.HOME ?? "",
): BackgroundShellConfig {
	const config: BackgroundShellConfig = { notifyOnExit: "context", maxJobsPerSession: DEFAULT_MAX_JOBS_PER_SESSION };
	const layers = [getPiToolsSuiteUserConfigPath(homeDir)];
	if (env.PI_CONFIG_DIR) layers.push(join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const projectConfig = findProjectConfig(cwd);
	if (projectConfig) layers.push(projectConfig);
	for (const filePath of layers) {
		const section = readJsonc(filePath).backgroundShell;
		if (!isRecord(section)) continue;
		config.notifyOnExit = notifyMode(section.notifyOnExit) ?? config.notifyOnExit;
		config.maxJobsPerSession = jobLimit(section.maxJobsPerSession) ?? config.maxJobsPerSession;
	}
	config.notifyOnExit = notifyMode(env.PI_BACKGROUND_SHELL_NOTIFY_ON_EXIT) ?? config.notifyOnExit;
	config.maxJobsPerSession = jobLimit(env.PI_BACKGROUND_SHELL_MAX_JOBS) ?? config.maxJobsPerSession;
	return config;
}
