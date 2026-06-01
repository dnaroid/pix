import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export interface PiToolsSuiteConfig {
	enabled: boolean;
	disabledModules: string[];
}

type MutableConfig = {
	enabled: boolean;
	disabledModules: Set<string>;
};

type Env = Record<string, string | undefined>;

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

const DISABLED_LIST_KEYS = ["disabledModules", "disabledExtensions"];
const ENABLED_LIST_KEYS = ["enabledModules", "enabledExtensions"];
const MODULE_MAP_KEYS = ["modules", "extensions"];

export function getPiToolsSuiteUserConfigPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
}

function defaultUserConfigContent(moduleNames: readonly string[]): string {
	const disabledModuleLines = moduleNames.map((name) => `    // "${name}",`).join("\n");
	return `{
  // Disable individual pi-tools-suite modules by uncommenting entries below.
  // Later project config in .pi/pi-tools-suite.jsonc can re-enable modules.
  "disabledModules": [
${disabledModuleLines}
  ],

  // Dynamic Context Pruning (compress module) config lives under dcp.
  // Legacy dcp.jsonc files are still read, but this section wins at the
  // same global/env/project layer.
  // "dcp": {
  //   "compress": {
  //     "minContextPercent": 0.25,
  //     "nudgeFrequency": 1,
  //     "iterationNudgeThreshold": 8
  //   }
  // },

  // Async-subagents config also lives in this file under asyncSubagents.
  // Run /subagent-preset init to insert the bundled full sample, or uncomment
  // this minimal example when only vision masks need an override.
  // "asyncSubagents": {
  //   "vision": {
  //     "blindModelPatterns": ["zai/glm*", "glm*", "*/glm*"]
  //   }
  // },

  // User slash commands backed by saved prompt templates. Edit through
  // /prompt-commands, then run entries as normal slash commands.
  "promptCommands": {
    "commands": {
      // "review": {
      //   "description": "Run a focused code review prompt",
      //   "prompt": "Review the current change. Focus on correctness and risks."
      // }
    }
  }
}
`;
}

function ensureUserConfig(filePath: string, moduleNames: readonly string[]): void {
	if (existsSync(filePath)) return;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(filePath, defaultUserConfigContent(moduleNames));
	} catch {
		// Config creation is best-effort; loading should still work in read-only homes.
	}
}

export function ensurePiToolsSuiteUserConfig(moduleNames: readonly string[] = [], options: { homeDir?: string } = {}): string {
	const filePath = getPiToolsSuiteUserConfigPath(options.homeDir);
	ensureUserConfig(filePath, moduleNames);
	return filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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

	return config;
}

export function loadPiToolsSuiteConfig(moduleNames: readonly string[], options: { cwd?: string; env?: Env; homeDir?: string } = {}): PiToolsSuiteConfig {
	const env = options.env ?? process.env;
	const knownModules = new Set(moduleNames.map((name) => name.toLowerCase()));
	const config: MutableConfig = { enabled: true, disabledModules: new Set() };
	const userConfigPath = getPiToolsSuiteUserConfigPath(options.homeDir);

	ensureUserConfig(userConfigPath, moduleNames);
	mergeConfigLayer(config, readJsonc(userConfigPath), knownModules);

	const piConfigDir = env.PI_CONFIG_DIR;
	if (piConfigDir) mergeConfigLayer(config, readJsonc(join(piConfigDir, "pi-tools-suite.jsonc")), knownModules);

	const projectConfig = findProjectConfig(options.cwd ?? process.cwd());
	if (projectConfig) mergeConfigLayer(config, readJsonc(projectConfig), knownModules);

	applyEnv(config, env, knownModules);

	return {
		enabled: config.enabled,
		disabledModules: [...config.disabledModules].sort(),
	};
}
