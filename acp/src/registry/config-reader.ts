import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "jsonc-parser";

export interface ResourceRegistryConfig {
	remote?: string;
	branch: string;
	projectKey?: string;
}

export function getPiToolsSuiteUserConfigPath(): string {
	return join(process.env.HOME?.trim() || homedir(), ".config", "pi", "pi-tools-suite.jsonc");
}

const nonempty = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Read only the legacy Registry config section; never initialize tools-suite. */
export function loadRegistryConfig(cwd: string): ResourceRegistryConfig {
	const config: ResourceRegistryConfig = { branch: "main" };
	const merge = (file: string): void => {
		if (!existsSync(file)) return;
		const raw = parse(readFileSync(file, "utf8"))?.resourceRegistry;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		if (Object.hasOwn(raw, "remote")) {
			const remote = nonempty(raw.remote);
			if (remote) config.remote = remote;
			else delete config.remote;
		}
		config.branch = nonempty(raw.branch) ?? config.branch;
		if (Object.hasOwn(raw, "projectKey")) {
			const key = nonempty(raw.projectKey);
			if (key) config.projectKey = key;
			else delete config.projectKey;
		}
	};
	merge(getPiToolsSuiteUserConfigPath());
	if (process.env.PI_CONFIG_DIR) merge(join(process.env.PI_CONFIG_DIR, "pi-tools-suite.jsonc"));
	let directory = resolve(cwd);
	while (true) {
		const file = join(directory, ".pi", "pi-tools-suite.jsonc");
		if (existsSync(file)) { merge(file); break; }
		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}
	const remote = nonempty(process.env.PI_RESOURCE_REGISTRY_REMOTE);
	const branch = nonempty(process.env.PI_RESOURCE_REGISTRY_BRANCH);
	const key = nonempty(process.env.PI_RESOURCE_REGISTRY_PROJECT_KEY);
	if (remote) config.remote = remote;
	if (branch) config.branch = branch;
	if (key) config.projectKey = key;
	return config;
}
