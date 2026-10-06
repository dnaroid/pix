import { ProjectContext, projectCwd, validateBranch, validateName } from "./paths.js";
import { dirname, isAbsolute, join } from "node:path";
import { PROJECT_DIR, PROVENANCE_FILE, RegistryRuntime } from "./model.js";
import { homedir } from "node:os";
import { getPiToolsSuiteUserConfigPath, loadRegistryConfig } from "./config-reader.js";
import { existsSync, promises as fs } from "node:fs";
import { applyEdits, modify } from "jsonc-parser";

export function provenancePath(project: ProjectContext): string {
	return join(projectCwd(project), PROJECT_DIR, PROVENANCE_FILE);
}

export function cacheRoot(): string {
	const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
	return join(base, "pi", "resource-registry");
}

export function registryUiCacheRoot(): string {
	return `${cacheRoot()}-desktop`;
}

export function loadRuntimeConfig(cwd: string): RegistryRuntime {
	const config = loadRegistryConfig(cwd);
	if (!config.remote) {
		throw new Error(`Resource registry is not configured. Configure the Git remote in Desktop Registry.`);
	}
	if (isAbsolute(config.remote) && !existsSync(config.remote)) {
		throw new Error(
			`Configured resource registry remote does not exist: ${config.remote}. `
			+ `Configure the Git remote in Desktop Registry to replace it.`,
		);
	}
	validateBranch(config.branch);
	return { remote: config.remote, branch: config.branch, cacheDir: registryUiCacheRoot() };
}

export async function saveRegistryConfig(remote: string, branch: string): Promise<void> {
	const trimmedRemote = remote.trim();
	if (!trimmedRemote) throw new Error("Registry remote cannot be empty.");
	validateBranch(branch);
	const filePath = getPiToolsSuiteUserConfigPath();
	await fs.mkdir(dirname(filePath), { recursive: true });
	let source = "{}\n";
	try {
		source = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	let edits = modify(source, ["resourceRegistry", "remote"], trimmedRemote, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	source = applyEdits(source, edits);
	edits = modify(source, ["resourceRegistry", "branch"], branch, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	source = applyEdits(source, edits);
	await fs.writeFile(filePath, source.endsWith("\n") ? source : `${source}\n`, "utf8");
}

export async function saveProjectKeyConfig(cwd: string, projectKey: string | undefined): Promise<void> {
	if (projectKey !== undefined) validateName(projectKey);
	const filePath = join(cwd, PROJECT_DIR, "pi-tools-suite.jsonc");
	await fs.mkdir(dirname(filePath), { recursive: true });
	let source = "{}\n";
	try {
		source = await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const edits = modify(source, ["resourceRegistry", "projectKey"], projectKey, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	source = applyEdits(source, edits);
	await fs.writeFile(filePath, source.endsWith("\n") ? source : `${source}\n`, "utf8");
}
