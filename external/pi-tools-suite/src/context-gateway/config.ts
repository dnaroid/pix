import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

import { getPiToolsSuiteUserConfigPath } from "../config.js";
import type {
	ContextGatewayBudgets,
	ContextGatewayMode,
	ContextGatewayResolvedConfig,
} from "./types.js";

export const DEFAULT_CONTEXT_GATEWAY_BUDGETS: Readonly<ContextGatewayBudgets> = Object.freeze({
	maxInlineBytes: 8_192,
	maxResultBytes: 8_192,
	maxExactReadBytes: 32_768,
	maxSearchBytes: 8_192,
	maxSearchMatches: 12,
});

export const CONTEXT_GATEWAY_ENFORCE_UNAVAILABLE =
	"Context Gateway enforce is unavailable in P01; mode unchanged until capture/store/result-stage integration is implemented.";

const MODES = new Set<ContextGatewayMode>(["off", "observe", "enforce"]);
const MAX_BYTE_BUDGET = 64 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 1_000;

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

function parseMode(value: unknown): ContextGatewayMode | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase() as ContextGatewayMode;
	return MODES.has(normalized) ? normalized : undefined;
}

function mergeBudget(
	budgets: ContextGatewayBudgets,
	issues: string[],
	key: keyof ContextGatewayBudgets,
	value: unknown,
): void {
	if (value === undefined) return;
	const maximum = key === "maxSearchMatches" ? MAX_SEARCH_MATCHES : MAX_BYTE_BUDGET;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
		issues.push(`contextGateway.budgets.${key} must be an integer in 1..${maximum}; keeping ${budgets[key]}.`);
		return;
	}
	budgets[key] = value;
}

export function loadContextGatewayConfig(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
	homeDir: string = env.HOME ?? process.env.HOME ?? "",
): ContextGatewayResolvedConfig {
	let mode: ContextGatewayMode = "off";
	const budgets: ContextGatewayBudgets = { ...DEFAULT_CONTEXT_GATEWAY_BUDGETS };
	const issues: string[] = [];

	const layers = [getPiToolsSuiteUserConfigPath(homeDir)];
	if (env.PI_CONFIG_DIR) layers.push(join(env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	const projectConfig = findProjectConfig(cwd);
	if (projectConfig) layers.push(projectConfig);

	for (const filePath of layers) {
		const section = readJsonc(filePath).contextGateway;
		if (!isRecord(section)) continue;
		if (Object.prototype.hasOwnProperty.call(section, "mode")) {
			const nextMode = parseMode(section.mode);
			if (nextMode) mode = nextMode;
			else issues.push(`contextGateway.mode must be off, observe, or enforce; keeping ${mode}.`);
		}
		if (isRecord(section.budgets)) {
			for (const key of Object.keys(DEFAULT_CONTEXT_GATEWAY_BUDGETS) as Array<keyof ContextGatewayBudgets>) {
				mergeBudget(budgets, issues, key, section.budgets[key]);
			}
		}
	}

	if (env.PI_CONTEXT_GATEWAY_MODE !== undefined) {
		const envMode = parseMode(env.PI_CONTEXT_GATEWAY_MODE);
		if (envMode) mode = envMode;
		else issues.push("PI_CONTEXT_GATEWAY_MODE must be off, observe, or enforce; ignoring it.");
	}

	return { mode, budgets, issues };
}
