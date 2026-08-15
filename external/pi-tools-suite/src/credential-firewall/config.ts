import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import { getPiToolsSuiteUserConfigPath } from "../config.js";

export interface SecretFirewallConfig {
	sessionHygiene: boolean;
	notify: boolean;
}

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

function boolFromEnv(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (TRUE_VALUES.has(normalized)) return true;
	if (FALSE_VALUES.has(normalized)) return false;
	return undefined;
}

export function loadSecretFirewallConfig(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = env.HOME ?? process.env.HOME ?? "",
): SecretFirewallConfig {
	let sessionHygiene = true;
	let notify = true;

	const layers = [getPiToolsSuiteUserConfigPath(homeDir)];
	if (env.PI_CONFIG_DIR) layers.push(join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const projectConfig = findProjectConfig(cwd);
	if (projectConfig) layers.push(projectConfig);

	for (const filePath of layers) {
		const root = readJsonc(filePath);
		const section = root.secretFirewall;
		if (!isRecord(section)) continue;
		if (typeof section.sessionHygiene === "boolean") sessionHygiene = section.sessionHygiene;
		if (typeof section.notify === "boolean") notify = section.notify;
	}

	const envSessionHygiene = boolFromEnv(env.PI_SECRET_FIREWALL_SESSION_HYGIENE);
	if (envSessionHygiene !== undefined) sessionHygiene = envSessionHygiene;
	const envNotify = boolFromEnv(env.PI_SECRET_FIREWALL_NOTIFY);
	if (envNotify !== undefined) notify = envNotify;

	return { sessionHygiene, notify };
}
