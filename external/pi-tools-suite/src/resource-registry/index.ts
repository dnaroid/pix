import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyEdits, modify } from "jsonc-parser";

import { parseAgentMarkdown } from "../async-subagents/core/agents-dir.js";
import { getPiToolsSuiteUserConfigPath, loadPiToolsSuiteConfig, type ResourceRegistryConfig } from "../config.js";
import { ignoreStaleExtensionContextError, isStaleExtensionContextError } from "../context-usage.js";
import { publishRpcSessionState, RPC_SESSION_STATE_ENV } from "../lib/rpc-session-state.js";

const COMMAND = "registry";
const PROJECT_DIR = ".pi";
const PROJECT_SKILLS_DIR = "skills";
const PROJECT_AGENTS_DIR = "agents";
const REGISTRY_SKILLS_DIR = "skills";
const REGISTRY_AGENTS_DIR = "agents";
const REGISTRY_PROJECTS_DIR = "projects";
const SKILL_FILE = "SKILL.md";
const PROJECT_TASKS_FILE = "tasks.jsonc";
const PROJECT_PLANS_DIR = "plans";
const PROJECT_TODO_FILE = "TODO.md";
const PROVENANCE_FILE = "registry.json";
const PROVENANCE_VERSION = 1;
const SYSTEM_CUSTOM_MESSAGE_TYPE = "pix-system";
const STATUS_MESSAGE_KIND = "resource-registry-status";
export const REGISTRY_STATE_EVENT = "pi-tools-suite:resource-registry:state";
const DESC_MAX = 90;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SKIP_NAMES = new Set([".DS_Store"]);

export type ResourceType = "skill" | "agent";
type ResourceScope = ResourceType | "all";
export type ProjectArtifact = "tasks" | "plans" | "todo";
type ProjectScope = ProjectArtifact | "project";
type RegistryAction = "install" | "push" | "pull" | "remove" | "uninstall" | "status" | "update" | "configure" | "remote" | "project-key";

type ResourceEntry = {
	type: ResourceType;
	name: string;
	path: string;
	description: string;
};

type ProvenanceEntry = {
	type: ResourceType;
	name: string;
	remote: string;
	branch: string;
	revision: string;
	hash: string;
};

type Provenance = {
	version: 1;
	resources: Record<string, ProvenanceEntry>;
	projectResources: Partial<Record<ProjectArtifact, ProjectProvenanceEntry>>;
};

type ProjectProvenanceEntry = {
	artifact: ProjectArtifact;
	projectKey: string;
	remote: string;
	branch: string;
	revision: string;
	hash: string;
};

export type RegistryStatusKind =
	| "up-to-date"
	| "update-available"
	| "local-changes"
	| "diverged"
	| "not-installed"
	| "local-only"
	| "untracked-local"
	| "missing-local"
	| "removed-remote"
	| "registry-changed";

type RegistryStatus = {
	type: ResourceType;
	name: string;
	kind: RegistryStatusKind;
	local?: ResourceEntry;
	remote?: ResourceEntry;
	provenance?: ProvenanceEntry;
	remoteRevision?: string;
};

type RegistryRuntime = {
	remote: string;
	branch: string;
	cacheDir: string;
};

type ProjectArtifactStatus = {
	artifact: ProjectArtifact;
	kind: RegistryStatusKind;
	localExists: boolean;
	remoteExists: boolean;
	provenance?: ProjectProvenanceEntry;
	remoteRevision?: string;
};

type ProjectStatusBundle = {
	projectKey?: string;
	statuses: ProjectArtifactStatus[];
	issue?: string;
};

export type RegistryUiAction = "install" | "update" | "push" | "pull" | "uninstall" | "remove";

export interface RegistryUiItem {
	readonly id: string;
	readonly type: ResourceType | "project";
	readonly name: string;
	readonly artifact?: ProjectArtifact;
	readonly status: RegistryStatusKind;
	readonly statusLabel: string;
	readonly icon: string;
	readonly description?: string;
	readonly local: boolean;
	readonly remote: boolean;
	readonly actions: readonly RegistryUiAction[];
}

export interface RegistryUiSnapshot {
	readonly version: 1;
	readonly configured: boolean;
	readonly remote?: string;
	readonly branch: string;
	readonly projectKey?: string;
	readonly projectIssue?: string;
	readonly items: readonly RegistryUiItem[];
	readonly checkedAt: string;
	readonly error?: string;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, type);
	else console.log(message);
}

function sendStatusSystemMessage(
	pi: ExtensionAPI,
	statuses: RegistryStatus[],
	runtime: RegistryRuntime,
	projectStatus?: ProjectStatusBundle,
): void {
	pi.sendMessage({
		customType: SYSTEM_CUSTOM_MESSAGE_TYPE,
		content: formatStatuses(statuses, runtime, projectStatus),
		display: true,
		details: {
			kind: STATUS_MESSAGE_KIND,
			userVisibleOnly: true,
			remote: runtime.remote,
			branch: runtime.branch,
			generatedAt: new Date().toISOString(),
		},
	});
}

function truncate(value: string, maxLength: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resourceKey(type: ResourceType, name: string): string {
	return `${type}:${name}`;
}

function resourceType(value: string | undefined): ResourceType | undefined {
	if (value === "skill" || value === "skills") return "skill";
	if (value === "agent" || value === "agents") return "agent";
	return undefined;
}

function matchesScope(type: ResourceType, scope: ResourceScope): boolean {
	return scope === "all" || type === scope;
}

function projectScope(value: string | undefined): ProjectScope | undefined {
	if (value === "tasks") return "tasks";
	if (value === "plans") return "plans";
	if (value === "todo") return "todo";
	if (value === "project") return "project";
	return undefined;
}

function validateName(name: string): void {
	if (!SAFE_NAME.test(name) || name === "." || name === ".." || name.includes("..")) {
		throw new Error(`Invalid resource name "${name}". Use letters, digits, dot, underscore, or dash.`);
	}
}

function validateBranch(branch: string): void {
	if (
		!SAFE_BRANCH.test(branch)
		|| branch.startsWith("-")
		|| branch.endsWith("/")
		|| branch.includes("//")
		|| branch.includes("..")
		|| branch.includes("@{")
	) {
		throw new Error(`Invalid registry branch "${branch}".`);
	}
}

function projectResourcePath(ctx: ExtensionContext, type: ResourceType, name: string): string {
	validateName(name);
	return type === "skill"
		? join(ctx.cwd, PROJECT_DIR, PROJECT_SKILLS_DIR, name)
		: join(ctx.cwd, PROJECT_DIR, PROJECT_AGENTS_DIR, `${name}.md`);
}

function registryResourceRelativePath(type: ResourceType, name: string): string {
	validateName(name);
	return type === "skill" ? `${REGISTRY_SKILLS_DIR}/${name}` : `${REGISTRY_AGENTS_DIR}/${name}.md`;
}

function registryResourcePath(cacheDir: string, type: ResourceType, name: string): string {
	return join(cacheDir, ...registryResourceRelativePath(type, name).split("/"));
}

function projectArtifactLocalPath(cwd: string, artifact: ProjectArtifact): string {
	switch (artifact) {
		case "tasks": return join(cwd, PROJECT_DIR, PROJECT_TASKS_FILE);
		case "plans": return join(cwd, PROJECT_DIR, PROJECT_PLANS_DIR);
		case "todo": return join(cwd, PROJECT_DIR, PROJECT_TODO_FILE);
	}
}

function projectArtifactRelativePath(projectKey: string, artifact: ProjectArtifact): string {
	validateName(projectKey);
	switch (artifact) {
		case "tasks": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_TASKS_FILE}`;
		case "plans": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_PLANS_DIR}`;
		case "todo": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_TODO_FILE}`;
	}
}

function projectArtifactDisplayName(artifact: ProjectArtifact): string {
	switch (artifact) {
		case "tasks": return PROJECT_TASKS_FILE;
		case "plans": return `${PROJECT_PLANS_DIR}/`;
		case "todo": return PROJECT_TODO_FILE;
	}
}

function projectArtifactRegistryPath(cacheDir: string, projectKey: string, artifact: ProjectArtifact): string {
	return join(cacheDir, ...projectArtifactRelativePath(projectKey, artifact).split("/"));
}

function canonicalGitRemote(remote: string): string | undefined {
	const trimmed = remote.trim();
	if (!trimmed) return undefined;
	const stripPath = (value: string) => value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
	const scp = !trimmed.includes("://") ? trimmed.match(/^(?:[^@/]+@)?([^:]+):(.+)$/) : null;
	if (scp) {
		const host = scp[1]?.toLowerCase();
		const path = stripPath(scp[2] ?? "");
		if (host && path) return `${host}/${path}`;
	}
	try {
		const url = new URL(trimmed);
		if (url.protocol === "file:") {
			const path = stripPath(url.pathname);
			if (!path) return undefined;
			const leaf = basename(path).replace(/\.git$/i, "") || "repo";
			return `local/${leaf}--${createHash("sha256").update(trimmed).digest("hex").slice(0, 8)}`;
		}
		const host = url.hostname.toLowerCase();
		const path = stripPath(url.pathname);
		if (host && path) return `${host}/${path}`;
	} catch {
		if (trimmed.startsWith("/") || trimmed.startsWith(".")) {
			const leaf = basename(trimmed).replace(/\.git$/i, "") || "repo";
			return `local/${leaf}--${createHash("sha256").update(trimmed).digest("hex").slice(0, 8)}`;
		}
	}
	return undefined;
}

function projectKeyFromGitRemote(remote: string): string | undefined {
	const canonical = canonicalGitRemote(remote);
	if (!canonical) return undefined;
	const key = canonical
		.split("/")
		.map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, ""))
		.filter(Boolean)
		.join("__");
	return key && SAFE_NAME.test(key) && !key.includes("..") ? key : undefined;
}

function provenancePath(ctx: ExtensionContext): string {
	return join(ctx.cwd, PROJECT_DIR, PROVENANCE_FILE);
}

function cacheRoot(): string {
	const base = process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
	return join(base, "pi", "resource-registry");
}

function startupCheckCacheRoot(): string {
	return `${cacheRoot()}-startup-check`;
}

function registryUiCacheRoot(): string {
	return `${cacheRoot()}-desktop-${process.pid}`;
}

function loadRuntimeConfig(cwd: string): RegistryRuntime {
	const config = loadPiToolsSuiteConfig([], { cwd }).resourceRegistry;
	if (!config.remote) {
		throw new Error(`Resource registry is not configured. Run /${COMMAND} configure <git-url> [branch].`);
	}
	validateBranch(config.branch);
	return { remote: config.remote, branch: config.branch, cacheDir: cacheRoot() };
}

async function saveRegistryConfig(remote: string, branch: string): Promise<void> {
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

async function saveProjectKeyConfig(cwd: string, projectKey: string | undefined): Promise<void> {
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

async function hasTrackableFiles(path: string): Promise<boolean> {
	const stat = await fs.lstat(path);
	if (stat.isFile()) return true;
	if (!stat.isDirectory()) return true;
	for (const entry of await fs.readdir(path, { withFileTypes: true })) {
		if (SKIP_NAMES.has(entry.name)) continue;
		if (entry.isFile() || entry.isSymbolicLink()) return true;
		if (entry.isDirectory() && await hasTrackableFiles(join(path, entry.name))) return true;
	}
	return false;
}

async function runGit(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	options: { allowFailure?: boolean; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
	const result = await pi.exec("git", args, { cwd, timeout: options.timeout ?? 120_000 });
	const code = result.code ?? 0;
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	if (code !== 0 && !options.allowFailure) {
		throw new Error(stderr.trim() || stdout.trim() || `git ${args[0] ?? "command"} failed with exit code ${code}`);
	}
	return { stdout, stderr, code };
}

async function resolveProjectKey(pi: ExtensionAPI, cwd: string): Promise<string> {
	const configured = loadPiToolsSuiteConfig([], { cwd }).resourceRegistry.projectKey?.trim();
	if (configured) {
		validateName(configured);
		return configured;
	}
	const origin = (await runGit(pi, cwd, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
	const derived = projectKeyFromGitRemote(origin);
	if (derived) return derived;
	throw new Error(`Cannot determine this project's registry key from Git origin. Run /${COMMAND} project-key <key> in this project.`);
}

async function gitRefExists(pi: ExtensionAPI, cwd: string, ref: string): Promise<boolean> {
	return (await runGit(pi, cwd, ["rev-parse", "--verify", "--quiet", ref], { allowFailure: true })).code === 0;
}

async function ensureRegistryCache(pi: ExtensionAPI, runtime: RegistryRuntime): Promise<void> {
	const gitDir = join(runtime.cacheDir, ".git");
	if (await pathExists(gitDir)) {
		const currentRemote = (await runGit(pi, runtime.cacheDir, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
		if (currentRemote !== runtime.remote) await fs.rm(runtime.cacheDir, { recursive: true, force: true });
	} else if (await pathExists(runtime.cacheDir)) {
		await fs.rm(runtime.cacheDir, { recursive: true, force: true });
	}

	if (!(await pathExists(gitDir))) {
		await fs.mkdir(dirname(runtime.cacheDir), { recursive: true });
		await runGit(pi, dirname(runtime.cacheDir), ["clone", "--origin", "origin", runtime.remote, runtime.cacheDir], { timeout: 180_000 });
	}

	await runGit(pi, runtime.cacheDir, ["reset", "--hard"], { allowFailure: true });
	await runGit(pi, runtime.cacheDir, ["clean", "-fd"]);
	await runGit(pi, runtime.cacheDir, ["fetch", "origin", "--prune"], { timeout: 180_000 });

	const remoteRef = `refs/remotes/origin/${runtime.branch}`;
	if (await gitRefExists(pi, runtime.cacheDir, remoteRef)) {
		await runGit(pi, runtime.cacheDir, ["checkout", "-B", runtime.branch, `origin/${runtime.branch}`]);
		return;
	}

	if (await gitRefExists(pi, runtime.cacheDir, "HEAD")) {
		throw new Error(`Registry branch "${runtime.branch}" does not exist on ${runtime.remote}. Configure the correct branch.`);
	}

	const currentBranch = (await runGit(pi, runtime.cacheDir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).stdout.trim();
	if (currentBranch !== runtime.branch) {
		await runGit(pi, runtime.cacheDir, ["checkout", "--orphan", runtime.branch]);
	}
}

async function pathRevision(pi: ExtensionAPI, runtime: RegistryRuntime, rel: string): Promise<string | undefined> {
	const result = await runGit(pi, runtime.cacheDir, ["log", "-1", "--format=%H", "--", rel], { allowFailure: true });
	const revision = result.stdout.trim();
	return revision || undefined;
}

async function resourceRevision(pi: ExtensionAPI, runtime: RegistryRuntime, type: ResourceType, name: string): Promise<string | undefined> {
	return pathRevision(pi, runtime, registryResourceRelativePath(type, name));
}

function parseFrontmatterDescription(content: string): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return "";
	const lines = (match[1] ?? "").split(/\r?\n/);
	const idx = lines.findIndex((line) => /^\s*description:\s*/.test(line));
	if (idx === -1) return "";
	const headerLine = lines[idx] ?? "";
	const after = headerLine.replace(/^\s*description:\s*/, "");
	if (/^[>|]/.test(after)) {
		const block: string[] = [];
		for (let i = idx + 1; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			if (line === "") {
				block.push(" ");
				continue;
			}
			if (/^\s+/.test(line)) {
				block.push(line.replace(/^\s+/, ""));
				continue;
			}
			break;
		}
		return block.join(" ").trim();
	}
	let value = after.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	return value;
}

async function readDescription(path: string): Promise<string> {
	try {
		return parseFrontmatterDescription(await fs.readFile(path, "utf8"));
	} catch {
		return "";
	}
}

async function validAgentDefinition(path: string, name: string): Promise<boolean> {
	try {
		const parsed = parseAgentMarkdown(await fs.readFile(path, "utf8"), path);
		if (!parsed) return false;
		const declaredName = parsed.frontmatter.name;
		return declaredName === undefined || declaredName === name;
	} catch {
		return false;
	}
}

async function assertValidAgentDefinition(path: string, name: string): Promise<void> {
	if (!(await validAgentDefinition(path, name))) {
		throw new Error(`Agent "${name}" must be a valid .pi/agents Markdown definition with YAML frontmatter matching its filename.`);
	}
}

async function scanSkills(dir: string): Promise<ResourceEntry[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const resources: ResourceEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_NAMES.has(entry.name)) continue;
		if (!SAFE_NAME.test(entry.name) || entry.name.includes("..")) continue;
		const skillPath = join(dir, entry.name);
		const skillFile = join(skillPath, SKILL_FILE);
		if (!(await pathExists(skillFile))) continue;
		resources.push({ type: "skill", name: entry.name, path: skillPath, description: await readDescription(skillFile) });
	}
	return resources.sort((a, b) => a.name.localeCompare(b.name));
}

async function scanAgents(dir: string): Promise<ResourceEntry[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const resources: ResourceEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
		const name = basename(entry.name, ".md");
		if (!SAFE_NAME.test(name) || name.includes("..")) continue;
		const filePath = join(dir, entry.name);
		if (!(await validAgentDefinition(filePath, name))) continue;
		resources.push({ type: "agent", name, path: filePath, description: await readDescription(filePath) });
	}
	return resources.sort((a, b) => a.name.localeCompare(b.name));
}

async function scanRegistry(runtime: RegistryRuntime): Promise<ResourceEntry[]> {
	return [
		...(await scanSkills(join(runtime.cacheDir, REGISTRY_SKILLS_DIR))),
		...(await scanAgents(join(runtime.cacheDir, REGISTRY_AGENTS_DIR))),
	];
}

async function scanProject(ctx: ExtensionContext): Promise<ResourceEntry[]> {
	return [
		...(await scanSkills(join(ctx.cwd, PROJECT_DIR, PROJECT_SKILLS_DIR))),
		...(await scanAgents(join(ctx.cwd, PROJECT_DIR, PROJECT_AGENTS_DIR))),
	];
}

async function copyTree(source: string, destination: string, relativePath = ""): Promise<void> {
	const stat = await fs.lstat(source);
	if (stat.isSymbolicLink()) throw new Error(`Registry resources cannot contain symbolic links: ${relativePath || source}`);
	if (stat.isFile()) {
		await fs.mkdir(dirname(destination), { recursive: true });
		await fs.copyFile(source, destination);
		return;
	}
	if (!stat.isDirectory()) throw new Error(`Unsupported registry resource entry: ${relativePath || source}`);
	await fs.mkdir(destination, { recursive: true });
	const entries = (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (SKIP_NAMES.has(entry.name)) continue;
		const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) throw new Error(`Registry resources cannot contain symbolic links: ${childRel}`);
		await copyTree(join(source, entry.name), join(destination, entry.name), childRel);
	}
}

async function replaceResource(source: string, destination: string): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await copyTree(source, destination);
}

async function hashPath(path: string): Promise<string> {
	const hash = createHash("sha256");
	async function visit(current: string, rel: string): Promise<void> {
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) throw new Error(`Resource cannot contain symbolic links: ${rel || current}`);
		if (stat.isFile()) {
			hash.update(`file\0${rel}\0`);
			hash.update(await fs.readFile(current));
			return;
		}
		if (!stat.isDirectory()) throw new Error(`Unsupported resource entry: ${rel || current}`);
		hash.update(`dir\0${rel}\0`);
		const names = (await fs.readdir(current)).filter((name) => !SKIP_NAMES.has(name)).sort();
		for (const name of names) await visit(join(current, name), rel ? `${rel}/${name}` : name);
	}
	await visit(path, "");
	return hash.digest("hex");
}

async function readProvenance(ctx: ExtensionContext): Promise<Provenance> {
	try {
		const parsed = JSON.parse(await fs.readFile(provenancePath(ctx), "utf8")) as Partial<Provenance>;
		if (parsed.version !== PROVENANCE_VERSION || !parsed.resources || typeof parsed.resources !== "object") {
			return { version: PROVENANCE_VERSION, resources: {}, projectResources: {} };
		}
		return {
			version: PROVENANCE_VERSION,
			resources: parsed.resources,
			projectResources: parsed.projectResources && typeof parsed.projectResources === "object" ? parsed.projectResources : {},
		};
	} catch {
		return { version: PROVENANCE_VERSION, resources: {}, projectResources: {} };
	}
}

async function writeProvenance(ctx: ExtensionContext, provenance: Provenance): Promise<void> {
	const filePath = provenancePath(ctx);
	await fs.mkdir(dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
}

async function recordProvenance(
	ctx: ExtensionContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
	revision: string,
	hash: string,
): Promise<void> {
	const provenance = await readProvenance(ctx);
	provenance.resources[resourceKey(type, name)] = {
		type,
		name,
		remote: runtime.remote,
		branch: runtime.branch,
		revision,
		hash,
	};
	await writeProvenance(ctx, provenance);
}

async function clearResourceProvenance(ctx: ExtensionContext, type: ResourceType, name: string): Promise<void> {
	const provenance = await readProvenance(ctx);
	const key = resourceKey(type, name);
	if (!(key in provenance.resources)) return;
	delete provenance.resources[key];
	await writeProvenance(ctx, provenance);
}

async function clearResourceProvenanceEntries(ctx: ExtensionContext, entries: ResourceEntry[]): Promise<void> {
	const provenance = await readProvenance(ctx);
	let changed = false;
	for (const entry of entries) {
		const key = resourceKey(entry.type, entry.name);
		if (!(key in provenance.resources)) continue;
		delete provenance.resources[key];
		changed = true;
	}
	if (changed) await writeProvenance(ctx, provenance);
}

async function recordProjectProvenance(
	ctx: ExtensionContext,
	runtime: RegistryRuntime,
	projectKey: string,
	artifact: ProjectArtifact,
	revision: string,
	hash: string,
): Promise<void> {
	const provenance = await readProvenance(ctx);
	provenance.projectResources[artifact] = {
		artifact,
		projectKey,
		remote: runtime.remote,
		branch: runtime.branch,
		revision,
		hash,
	};
	await writeProvenance(ctx, provenance);
}

async function collectStatuses(pi: ExtensionAPI, ctx: ExtensionContext, runtime: RegistryRuntime): Promise<RegistryStatus[]> {
	const [remoteResources, localResources, provenance] = await Promise.all([
		scanRegistry(runtime),
		scanProject(ctx),
		readProvenance(ctx),
	]);
	const remoteMap = new Map(remoteResources.map((entry) => [resourceKey(entry.type, entry.name), entry]));
	const localMap = new Map(localResources.map((entry) => [resourceKey(entry.type, entry.name), entry]));
	const keys = new Set([...remoteMap.keys(), ...localMap.keys(), ...Object.keys(provenance.resources)]);
	const statuses: RegistryStatus[] = [];

	for (const key of [...keys].sort()) {
		const remote = remoteMap.get(key);
		const local = localMap.get(key);
		const tracked = provenance.resources[key];
		const type = remote?.type ?? local?.type ?? tracked?.type;
		const name = remote?.name ?? local?.name ?? tracked?.name;
		if (!type || !name) continue;

		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch)) {
			statuses.push({ type, name, kind: "registry-changed", local, remote, provenance: tracked });
			continue;
		}

		if (!local && !tracked) {
			statuses.push({ type, name, kind: "not-installed", remote });
			continue;
		}
		if (local && !tracked) {
			statuses.push({ type, name, kind: remote ? "untracked-local" : "local-only", local, remote });
			continue;
		}
		if (tracked && !local) {
			statuses.push({ type, name, kind: remote ? "missing-local" : "removed-remote", remote, provenance: tracked });
			continue;
		}
		if (!tracked || !local) continue;
		if (!remote) {
			statuses.push({ type, name, kind: "removed-remote", local, provenance: tracked });
			continue;
		}

		const [localHash, remoteRevision] = await Promise.all([
			hashPath(local.path),
			resourceRevision(pi, runtime, type, name),
		]);
		const localChanged = localHash !== tracked.hash;
		const remoteChanged = remoteRevision !== tracked.revision;
		const kind: RegistryStatusKind = localChanged && remoteChanged
			? "diverged"
			: localChanged
				? "local-changes"
				: remoteChanged
					? "update-available"
					: "up-to-date";
		statuses.push({ type, name, kind, local, remote, provenance: tracked, remoteRevision });
	}

	return statuses;
}

function projectArtifacts(scope: ProjectScope): ProjectArtifact[] {
	return scope === "project" ? ["tasks", "plans", "todo"] : [scope];
}

async function collectProjectStatuses(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: RegistryRuntime,
): Promise<ProjectStatusBundle> {
	let projectKey: string;
	try {
		projectKey = await resolveProjectKey(pi, ctx.cwd);
	} catch (error) {
		return { statuses: [], issue: error instanceof Error ? error.message : String(error) };
	}
	const provenance = await readProvenance(ctx);
	const statuses: ProjectArtifactStatus[] = [];
	for (const artifact of ["tasks", "plans", "todo"] as const) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		const [localExists, remoteExists] = await Promise.all([pathExists(localPath), pathExists(remotePath)]);
		const tracked = provenance.projectResources[artifact];
		if (!localExists && !remoteExists && !tracked) continue;
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			statuses.push({ artifact, kind: "registry-changed", localExists, remoteExists, provenance: tracked });
			continue;
		}
		if (!localExists && !tracked) {
			statuses.push({ artifact, kind: "not-installed", localExists, remoteExists });
			continue;
		}
		if (localExists && !tracked) {
			statuses.push({ artifact, kind: remoteExists ? "untracked-local" : "local-only", localExists, remoteExists });
			continue;
		}
		if (tracked && !localExists) {
			statuses.push({ artifact, kind: remoteExists ? "missing-local" : "removed-remote", localExists, remoteExists, provenance: tracked });
			continue;
		}
		if (!tracked || !localExists) continue;
		if (!remoteExists) {
			statuses.push({ artifact, kind: "removed-remote", localExists, remoteExists, provenance: tracked });
			continue;
		}
		const rel = projectArtifactRelativePath(projectKey, artifact);
		const [localHash, remoteRevision] = await Promise.all([
			hashPath(localPath),
			pathRevision(pi, runtime, rel),
		]);
		const localChanged = localHash !== tracked.hash;
		const remoteChanged = remoteRevision !== tracked.revision;
		const kind: RegistryStatusKind = localChanged && remoteChanged
			? "diverged"
			: localChanged
				? "local-changes"
				: remoteChanged
					? "update-available"
					: "up-to-date";
		statuses.push({ artifact, kind, localExists, remoteExists, provenance: tracked, remoteRevision });
	}
	return { projectKey, statuses };
}

function statusIcon(kind: RegistryStatusKind): string {
	switch (kind) {
		case "up-to-date": return "✓";
		case "update-available": return "↓";
		case "local-changes": return "↑";
		case "diverged": return "↕";
		case "not-installed": return "·";
		case "local-only": return "+";
		case "untracked-local": return "?";
		case "missing-local": return "!";
		case "removed-remote": return "×";
		case "registry-changed": return "!";
	}
}

function statusLabel(kind: RegistryStatusKind): string {
	switch (kind) {
		case "up-to-date": return "UP TO DATE";
		case "update-available": return "OUTDATED";
		case "local-changes": return "LOCAL CHANGES";
		case "diverged": return "CONFLICT";
		case "not-installed": return "NOT INSTALLED";
		case "local-only": return "LOCAL ONLY";
		case "untracked-local": return "UNTRACKED LOCAL";
		case "missing-local": return "MISSING LOCALLY";
		case "removed-remote": return "REMOVED FROM REGISTRY";
		case "registry-changed": return "OTHER REGISTRY";
	}
}

function resourceTypeBadge(type: ResourceType | "project"): string {
	switch (type) {
		case "skill": return "[SKILL]";
		case "agent": return "[AGENT]";
		case "project": return "[PROJECT]";
	}
}

const STATUS_GROUP_ORDER: readonly RegistryStatusKind[] = [
	"diverged",
	"update-available",
	"local-changes",
	"missing-local",
	"registry-changed",
	"removed-remote",
	"untracked-local",
	"local-only",
	"not-installed",
	"up-to-date",
];

function registryStatusRank(kind: RegistryStatusKind): number {
	const index = STATUS_GROUP_ORDER.indexOf(kind);
	return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function reusableUiActions(status: RegistryStatus): RegistryUiAction[] {
	const actions: RegistryUiAction[] = [];
	switch (status.kind) {
		case "not-installed":
			actions.push("install");
			break;
		case "update-available":
		case "missing-local":
			actions.push("update");
			break;
		case "local-changes":
		case "local-only":
		case "untracked-local":
		case "removed-remote":
			actions.push("push");
			break;
		case "up-to-date":
		case "diverged":
		case "registry-changed":
			break;
	}
	if (status.local) actions.push("uninstall");
	if (status.remote) actions.push("remove");
	return actions;
}

function projectUiActions(status: ProjectArtifactStatus): RegistryUiAction[] {
	switch (status.kind) {
		case "not-installed":
		case "update-available":
		case "missing-local":
			return ["pull"];
		case "local-changes":
		case "local-only":
		case "removed-remote":
			return ["push"];
		case "untracked-local":
			return status.remoteExists ? ["push", "pull"] : ["push"];
		case "up-to-date":
		case "diverged":
		case "registry-changed":
			return [];
	}
}

function registryUiItems(statuses: RegistryStatus[], projectStatus?: ProjectStatusBundle): RegistryUiItem[] {
	const items: RegistryUiItem[] = [
		...statuses.map((status): RegistryUiItem => ({
			id: `${status.type}:${status.name}`,
			type: status.type,
			name: status.name,
			status: status.kind,
			statusLabel: statusLabel(status.kind),
			icon: statusIcon(status.kind),
			...(status.local?.description || status.remote?.description
				? { description: status.local?.description || status.remote?.description }
				: {}),
			local: Boolean(status.local),
			remote: Boolean(status.remote),
			actions: reusableUiActions(status),
		})),
		...(projectStatus?.statuses ?? []).map((status): RegistryUiItem => ({
			id: `project:${status.artifact}`,
			type: "project",
			name: projectArtifactDisplayName(status.artifact),
			artifact: status.artifact,
			status: status.kind,
			statusLabel: statusLabel(status.kind),
			icon: statusIcon(status.kind),
			local: status.localExists,
			remote: status.remoteExists,
			actions: projectUiActions(status),
		})),
	];
	return items.sort((left, right) => {
		const byStatus = registryStatusRank(left.status) - registryStatusRank(right.status);
		if (byStatus !== 0) return byStatus;
		const byName = left.name.localeCompare(right.name);
		return byName !== 0 ? byName : left.id.localeCompare(right.id);
	});
}

async function collectRegistryUiSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	error?: string,
): Promise<RegistryUiSnapshot> {
	const config = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
	const checkedAt = new Date().toISOString();
	if (!config.remote) {
		return {
			version: 1,
			configured: false,
			branch: config.branch,
			items: [],
			checkedAt,
			...(error ? { error } : {}),
		};
	}
	const configuredRuntime = loadRuntimeConfig(ctx.cwd);
	const runtime: RegistryRuntime = { ...configuredRuntime, cacheDir: registryUiCacheRoot() };
	await ensureRegistryCache(pi, runtime);
	const [statuses, projectStatus] = await Promise.all([
		collectStatuses(pi, ctx, runtime),
		collectProjectStatuses(pi, ctx, runtime),
	]);
	return {
		version: 1,
		configured: true,
		remote: runtime.remote,
		branch: runtime.branch,
		...(projectStatus.projectKey ? { projectKey: projectStatus.projectKey } : {}),
		...(projectStatus.issue ? { projectIssue: projectStatus.issue } : {}),
		items: registryUiItems(statuses, projectStatus),
		checkedAt,
		...(error ? { error } : {}),
	};
}

async function publishRegistryUiSnapshot(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	error?: string,
): Promise<void> {
	let config: ResourceRegistryConfig | undefined;
	try {
		if (!registryRpcBridgeEnabled(ctx)) return;
		config = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
		publishRpcSessionState(ctx, REGISTRY_STATE_EVENT, await collectRegistryUiSnapshot(pi, ctx, error));
	} catch (snapshotError) {
		// Session replacement invalidates the old extension context while this
		// best-effort background snapshot may still be awaiting Git/filesystem
		// work. Never let that expected race escape the detached callback and
		// terminate the Pi RPC subprocess.
		if (isStaleExtensionContextError(snapshotError)) return;
		try {
			if (!registryRpcBridgeEnabled(ctx)) return;
			config ??= loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
			publishRpcSessionState(ctx, REGISTRY_STATE_EVENT, {
				version: 1,
				configured: Boolean(config.remote),
				...(config.remote ? { remote: config.remote } : {}),
				branch: config.branch,
				items: [],
				checkedAt: new Date().toISOString(),
				error: error ?? (snapshotError instanceof Error ? snapshotError.message : String(snapshotError)),
			} satisfies RegistryUiSnapshot);
		} catch (fallbackError) {
			if (isStaleExtensionContextError(fallbackError)) return;
			// Structured Desktop state is advisory. A failed fallback publication
			// must not make session startup/replacement fatal.
		}
	}
}

function registryRpcBridgeEnabled(ctx: ExtensionContext): boolean {
	return process.env[RPC_SESSION_STATE_ENV] === "1"
		&& (ctx as ExtensionContext & { mode?: unknown }).mode === "rpc"
		&& typeof (ctx.ui as unknown as { setWidget?: unknown }).setWidget === "function";
}

function scheduleRegistryUiSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): void {
	try {
		if (!registryRpcBridgeEnabled(ctx)) return;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return;
		throw error;
	}
	const timer = setTimeout(() => {
		void publishRegistryUiSnapshot(pi, ctx).catch(() => undefined);
	}, 0);
	timer.unref?.();
}

function formatStatuses(statuses: RegistryStatus[], runtime: RegistryRuntime, projectStatus?: ProjectStatusBundle): string {
	const lines = [`Registry: ${runtime.remote} (${runtime.branch})`];
	if (projectStatus) {
		if (projectStatus.projectKey) lines.push(`Project: ${projectStatus.projectKey}`);
		if (projectStatus.issue) lines.push(`Project state: ! ${projectStatus.issue}`);
	}

	type StatusLine = {
		kind: RegistryStatusKind;
		name: string;
		type: ResourceType | "project";
		tieBreaker: string;
	};
	const rows: StatusLine[] = [
		...statuses.map((status) => ({
			kind: status.kind,
			name: status.name,
			type: status.type,
			tieBreaker: status.type,
		})),
		...(projectStatus?.statuses ?? []).map((status) => ({
			kind: status.kind,
			name: projectArtifactDisplayName(status.artifact),
			type: "project" as const,
			tieBreaker: `project:${status.artifact}`,
		})),
	];
	const statusRank = new Map(STATUS_GROUP_ORDER.map((kind, index) => [kind, index]));
	rows.sort((left, right) => {
		const byStatus = (statusRank.get(left.kind) ?? Number.MAX_SAFE_INTEGER)
			- (statusRank.get(right.kind) ?? Number.MAX_SAFE_INTEGER);
		if (byStatus !== 0) return byStatus;
		const byName = left.name.localeCompare(right.name);
		return byName !== 0 ? byName : left.tieBreaker.localeCompare(right.tieBreaker);
	});

	if (rows.length > 0) {
		lines.push("");
		for (const row of rows) {
			lines.push(`${statusIcon(row.kind)} ${row.name}  ${resourceTypeBadge(row.type)}  **${statusLabel(row.kind)}**`);
		}
	} else if (!projectStatus?.issue) {
		lines.push("", `No skills, agents, ${PROJECT_TASKS_FILE}, ${PROJECT_PLANS_DIR}/, or ${PROJECT_TODO_FILE} state found locally or remotely.`);
	}
	return lines.join("\n");
}

function startupUpdateSummary(statuses: RegistryStatus[], projectStatuses: ProjectArtifactStatus[] = []): { updates: number; conflicts: number } {
	return {
		updates: statuses.filter((status) => status.kind === "update-available").length
			+ projectStatuses.filter((status) => ["update-available", "missing-local", "not-installed"].includes(status.kind)).length,
		conflicts: statuses.filter((status) => status.kind === "diverged").length
			+ projectStatuses.filter((status) => status.kind === "diverged").length,
	};
}

function formatStartupUpdateToast(summary: { updates: number; conflicts: number }): string {
	const parts: string[] = [];
	if (summary.updates > 0) parts.push(`${summary.updates} update${summary.updates === 1 ? "" : "s"} available`);
	if (summary.conflicts > 0) parts.push(`${summary.conflicts} conflict${summary.conflicts === 1 ? "" : "s"}`);
	return `Resource registry: ${parts.join(", ")}. Run /${COMMAND} status.`;
}

async function runStartupUpdateCheck(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		const runtime = loadRuntimeConfig(ctx.cwd);
		const checkRuntime: RegistryRuntime = { ...runtime, cacheDir: startupCheckCacheRoot() };
		await ensureRegistryCache(pi, checkRuntime);
		const [statuses, projectStatus] = await Promise.all([
			collectStatuses(pi, ctx, checkRuntime),
			collectProjectStatuses(pi, ctx, checkRuntime),
		]);
		const summary = startupUpdateSummary(statuses, projectStatus.statuses);
		if (summary.updates === 0 && summary.conflicts === 0) return;
		if (ctx.hasUI) ctx.ui.notify(formatStartupUpdateToast(summary), "warning");
	} catch {
		// Startup checks are best-effort and must never delay or fail application startup.
	}
}

function scheduleStartupUpdateCheck(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const config = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
	if (!config.remote) return;
	const timer = setTimeout(() => {
		void runStartupUpdateCheck(pi, ctx);
	}, 0);
	timer.unref?.();
}

async function confirmOverwrite(ctx: ExtensionCommandContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	try {
		return await ctx.ui.confirm(title, message);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return false;
	}
}

async function reloadAfterResourceChange(ctx: ExtensionCommandContext): Promise<void> {
	try {
		await ctx.reload();
	} catch (error) {
		ignoreStaleExtensionContextError(error);
	}
}

async function installResourceWithRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<void> {
	validateName(name);
	const source = registryResourcePath(runtime.cacheDir, type, name);
	if (!(await pathExists(source))) throw new Error(`${type} "${name}" does not exist in the registry.`);
	if (type === "skill" && !(await pathExists(join(source, SKILL_FILE)))) throw new Error(`Registry skill "${name}" is missing ${SKILL_FILE}.`);
	if (type === "agent") await assertValidAgentDefinition(source, name);
	const destination = projectResourcePath(ctx, type, name);
	if (await pathExists(destination)) {
		const confirmed = await confirmOverwrite(ctx, "Resource already exists", `Overwrite project ${type} "${name}" from the registry?`);
		if (!confirmed) throw new Error(`Project ${type} "${name}" already exists; install cancelled.`);
	}
	await replaceResource(source, destination);
	const revision = await resourceRevision(pi, runtime, type, name);
	if (!revision) throw new Error(`Cannot determine registry revision for ${type} "${name}".`);
	await recordProvenance(ctx, runtime, type, name, revision, await hashPath(destination));
}

async function installResource(pi: ExtensionAPI, ctx: ExtensionCommandContext, type: ResourceType, name: string): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	await installResourceWithRuntime(pi, ctx, runtime, type, name);
	const destination = projectResourcePath(ctx, type, name);
	notify(ctx, `Installed ${type} "${name}" → ${relative(ctx.cwd, destination)}. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function updateResourceWithRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<"updated" | "current"> {
	validateName(name);
	const provenance = await readProvenance(ctx);
	const tracked = provenance.resources[resourceKey(type, name)];
	if (!tracked) throw new Error(`${type} "${name}" is not tracked by the registry. Install it first.`);
	if (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch) {
		throw new Error(`${type} "${name}" was installed from ${tracked.remote} (${tracked.branch}); current registry is ${runtime.remote} (${runtime.branch}).`);
	}
	const source = registryResourcePath(runtime.cacheDir, type, name);
	if (!(await pathExists(source))) throw new Error(`${type} "${name}" was removed from the registry.`);
	const remoteRevision = await resourceRevision(pi, runtime, type, name);
	if (!remoteRevision) throw new Error(`Cannot determine registry revision for ${type} "${name}".`);
	const destination = projectResourcePath(ctx, type, name);
	if (await pathExists(destination)) {
		const localHash = await hashPath(destination);
		if (localHash !== tracked.hash) {
			throw new Error(`${type} "${name}" has local changes. Push them or resolve the divergence before updating.`);
		}
	}
	if (remoteRevision === tracked.revision && await pathExists(destination)) return "current";
	await replaceResource(source, destination);
	await recordProvenance(ctx, runtime, type, name, remoteRevision, await hashPath(destination));
	return "updated";
}

async function updateResource(pi: ExtensionAPI, ctx: ExtensionCommandContext, type: ResourceType, name: string): Promise<"updated" | "current"> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	return updateResourceWithRuntime(pi, ctx, runtime, type, name);
}

async function pushResourceWithRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<{ changed: boolean; revision?: string }> {
	validateName(name);
	const source = projectResourcePath(ctx, type, name);
	if (!(await pathExists(source))) throw new Error(`Project ${type} "${name}" does not exist.`);
	if (type === "skill" && !(await pathExists(join(source, SKILL_FILE)))) throw new Error(`Project skill "${name}" is missing ${SKILL_FILE}.`);
	if (type === "agent") await assertValidAgentDefinition(source, name);
	const destination = registryResourcePath(runtime.cacheDir, type, name);
	const provenance = await readProvenance(ctx);
	const tracked = provenance.resources[resourceKey(type, name)];
	const remoteExists = await pathExists(destination);
	const remoteRevision = remoteExists ? await resourceRevision(pi, runtime, type, name) : undefined;

	if (tracked && tracked.remote === runtime.remote && tracked.branch === runtime.branch && remoteRevision && remoteRevision !== tracked.revision) {
		throw new Error(`${type} "${name}" changed in the registry since revision ${tracked.revision.slice(0, 8)}. Run /${COMMAND} status and update/resolve before pushing.`);
	}

	const localHash = await hashPath(source);
	if (!tracked && remoteExists) {
		const remoteHash = await hashPath(destination);
		if (remoteHash !== localHash) {
			const confirmed = await confirmOverwrite(ctx, "Registry resource already exists", `Overwrite registry ${type} "${name}" with this project's untracked copy?`);
			if (!confirmed) throw new Error(`Registry ${type} "${name}" already exists; push cancelled.`);
		}
	}

	await replaceResource(source, destination);
	const rel = registryResourceRelativePath(type, name);
	await runGit(pi, runtime.cacheDir, ["add", "--", rel]);
	const changed = (await runGit(pi, runtime.cacheDir, ["status", "--porcelain", "--", rel])).stdout.trim();
	if (!changed) {
		const revision = remoteRevision ?? await resourceRevision(pi, runtime, type, name);
		if (revision) await recordProvenance(ctx, runtime, type, name, revision, localHash);
		return { changed: false, revision };
	}

	const verb = remoteExists ? "Update" : "Add";
	await runGit(pi, runtime.cacheDir, ["commit", "-m", `${verb} ${type} ${name}`, "--", rel]);
	try {
		await runGit(pi, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Registry commit was created in the disposable cache but push failed; the project copy is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}
	const revision = (await runGit(pi, runtime.cacheDir, ["rev-parse", "HEAD"])).stdout.trim();
	await recordProvenance(ctx, runtime, type, name, revision, localHash);
	return { changed: true, revision };
}

async function pushResource(pi: ExtensionAPI, ctx: ExtensionCommandContext, type: ResourceType, name: string): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const result = await pushResourceWithRuntime(pi, ctx, runtime, type, name);
	if (!result.changed) {
		notify(ctx, `${type} "${name}" already matches the registry.`);
		return;
	}
	const revision = result.revision;
	if (!revision) throw new Error(`Cannot determine pushed registry revision for ${type} "${name}".`);
	notify(ctx, `Pushed ${type} "${name}" to ${runtime.remote} (${runtime.branch}) at ${revision.slice(0, 8)}. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function removeResourceWithRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
	options: { confirm?: boolean } = {},
): Promise<string> {
	validateName(name);
	const target = registryResourcePath(runtime.cacheDir, type, name);
	if (!(await pathExists(target))) throw new Error(`Registry ${type} "${name}" does not exist.`);
	if (options.confirm !== false && ctx.hasUI) {
		const confirmed = await confirmOverwrite(
			ctx,
			"Remove registry resource",
			`Remove ${type} "${name}" from the registry? The project copy, if any, will be kept.`,
		);
		if (!confirmed) throw new Error(`Registry ${type} "${name}" removal cancelled.`);
	}

	const rel = registryResourceRelativePath(type, name);
	await fs.rm(target, { recursive: type === "skill", force: false });
	await runGit(pi, runtime.cacheDir, ["add", "-A", "--", rel]);
	const changed = (await runGit(pi, runtime.cacheDir, ["status", "--porcelain", "--", rel])).stdout.trim();
	if (!changed) throw new Error(`Registry ${type} "${name}" could not be staged for removal.`);
	await runGit(pi, runtime.cacheDir, ["commit", "-m", `Remove ${type} ${name}`, "--", rel]);
	try {
		await runGit(pi, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Registry removal commit was created in the disposable cache but push failed; the remote registry is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}
	return (await runGit(pi, runtime.cacheDir, ["rev-parse", "HEAD"])).stdout.trim();
}

async function removeResource(pi: ExtensionAPI, ctx: ExtensionCommandContext, type: ResourceType, name: string): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const revision = await removeResourceWithRuntime(pi, ctx, runtime, type, name);
	notify(ctx, `Removed ${type} "${name}" from ${runtime.remote} (${runtime.branch}) at ${revision.slice(0, 8)}. Project copies were kept. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function uninstallResource(
	ctx: ExtensionCommandContext,
	type: ResourceType,
	name: string,
	options: { confirm?: boolean } = {},
): Promise<void> {
	validateName(name);
	const target = projectResourcePath(ctx, type, name);
	if (!(await pathExists(target))) throw new Error(`Project ${type} "${name}" is not installed locally.`);
	if (options.confirm !== false && ctx.hasUI) {
		const confirmed = await confirmOverwrite(
			ctx,
			"Uninstall local resource",
			`Remove local ${type} "${name}" from ${relative(ctx.cwd, target)}? The registry copy will be kept.`,
		);
		if (!confirmed) throw new Error(`Local ${type} "${name}" uninstall cancelled.`);
	}
	await fs.rm(target, { recursive: type === "skill", force: false });
	await clearResourceProvenance(ctx, type, name);
	notify(ctx, `Uninstalled local ${type} "${name}". Registry copy was kept. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function pushProjectState(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ProjectScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const projectKey = await resolveProjectKey(pi, ctx.cwd);
	const requested = projectArtifacts(scope);
	const targets: ProjectArtifact[] = [];
	for (const artifact of requested) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		if (await pathExists(localPath)) {
			if (artifact === "plans" && !(await hasTrackableFiles(localPath))) {
				if (scope !== "project") throw new Error(`Project .pi/${PROJECT_PLANS_DIR}/ contains no files; Git cannot store an empty directory.`);
				continue;
			}
			targets.push(artifact);
		} else if (scope !== "project") {
			throw new Error(`Project .pi/${projectArtifactDisplayName(artifact)} does not exist.`);
		}
	}
	if (targets.length === 0) {
		notify(ctx, `No .pi/${PROJECT_TASKS_FILE}, .pi/${PROJECT_PLANS_DIR}/, or .pi/${PROJECT_TODO_FILE} state exists to push.`);
		return;
	}

	const provenance = await readProvenance(ctx);
	const metadata = new Map<ProjectArtifact, { localHash: string; remoteRevision?: string; remoteExists: boolean }>();
	const overwriteConflicts: ProjectArtifact[] = [];
	for (const artifact of targets) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		const rel = projectArtifactRelativePath(projectKey, artifact);
		const tracked = provenance.projectResources[artifact];
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			throw new Error(`${artifact} state is tracked under another registry/branch/project key. Run /${COMMAND} status before pushing.`);
		}
		const remoteExists = await pathExists(remotePath);
		const remoteRevision = remoteExists ? await pathRevision(pi, runtime, rel) : undefined;
		if (tracked && remoteRevision && remoteRevision !== tracked.revision) {
			throw new Error(`${artifact} state changed in the registry since revision ${tracked.revision.slice(0, 8)}. Pull or resolve it before pushing.`);
		}
		const localHash = await hashPath(localPath);
		if (!tracked && remoteExists && await hashPath(remotePath) !== localHash) overwriteConflicts.push(artifact);
		metadata.set(artifact, { localHash, remoteRevision, remoteExists });
	}

	if (overwriteConflicts.length > 0) {
		const names = overwriteConflicts.join(", ");
		const confirmed = await confirmOverwrite(
			ctx,
			"Project state already exists in registry",
			`Overwrite untracked remote project state for: ${names}?`,
		);
		if (!confirmed) throw new Error(`Project state push cancelled because remote state already exists for: ${names}.`);
	}

	const rels: string[] = [];
	for (const artifact of targets) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		await replaceResource(localPath, remotePath);
		rels.push(projectArtifactRelativePath(projectKey, artifact));
	}
	await runGit(pi, runtime.cacheDir, ["add", "--", ...rels]);
	const changed = (await runGit(pi, runtime.cacheDir, ["status", "--porcelain", "--", ...rels])).stdout.trim();
	if (changed) {
		await runGit(pi, runtime.cacheDir, ["commit", "-m", `Sync project state ${projectKey}`, "--", ...rels]);
		try {
			await runGit(pi, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
		} catch (error) {
			throw new Error(`Project-state commit was created in the disposable cache but push failed; local .pi state is unchanged. ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	for (const artifact of targets) {
		const rel = projectArtifactRelativePath(projectKey, artifact);
		const revision = await pathRevision(pi, runtime, rel);
		if (!revision) throw new Error(`Cannot determine registry revision for project ${artifact} state.`);
		await recordProjectProvenance(ctx, runtime, projectKey, artifact, revision, metadata.get(artifact)!.localHash);
	}
	notify(ctx, `${changed ? "Pushed" : "Project registry already matches"} ${targets.join(" + ")} for ${projectKey}.`);
}

async function pullProjectState(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ProjectScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const projectKey = await resolveProjectKey(pi, ctx.cwd);
	const requested = projectArtifacts(scope);
	const targets: ProjectArtifact[] = [];
	for (const artifact of requested) {
		if (await pathExists(projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact))) targets.push(artifact);
		else if (scope !== "project") throw new Error(`Registry has no ${artifact} state for project ${projectKey}.`);
	}
	if (targets.length === 0) {
		notify(ctx, `Registry has no ${PROJECT_TASKS_FILE}, ${PROJECT_PLANS_DIR}/, or ${PROJECT_TODO_FILE} state for project ${projectKey}.`);
		return;
	}

	const provenance = await readProvenance(ctx);
	const metadata = new Map<ProjectArtifact, { remoteRevision: string; remoteHash: string }>();
	const overwriteConflicts: ProjectArtifact[] = [];
	for (const artifact of targets) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		const rel = projectArtifactRelativePath(projectKey, artifact);
		const tracked = provenance.projectResources[artifact];
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			throw new Error(`${artifact} state is tracked under another registry/branch/project key. Run /${COMMAND} status before pulling.`);
		}
		const remoteRevision = await pathRevision(pi, runtime, rel);
		if (!remoteRevision) throw new Error(`Cannot determine registry revision for project ${artifact} state.`);
		const remoteHash = await hashPath(remotePath);
		if (await pathExists(localPath)) {
			const localHash = await hashPath(localPath);
			if (tracked && localHash !== tracked.hash) {
				throw new Error(`Project ${artifact} state has local changes. Push or resolve them before pulling.`);
			}
			if (!tracked && localHash !== remoteHash) overwriteConflicts.push(artifact);
		}
		metadata.set(artifact, { remoteRevision, remoteHash });
	}

	if (overwriteConflicts.length > 0) {
		const names = overwriteConflicts.join(", ");
		const confirmed = await confirmOverwrite(
			ctx,
			"Local project state already exists",
			`Overwrite untracked local project state from the registry for: ${names}?`,
		);
		if (!confirmed) throw new Error(`Project state pull cancelled because local state already exists for: ${names}.`);
	}

	for (const artifact of targets) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		await replaceResource(remotePath, localPath);
		const item = metadata.get(artifact)!;
		await recordProjectProvenance(ctx, runtime, projectKey, artifact, item.remoteRevision, item.remoteHash);
	}
	notify(ctx, `Pulled ${targets.join(" + ")} for ${projectKey}. Reloading project state…`);
	await reloadAfterResourceChange(ctx);
}

async function installAll(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ResourceScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const [remoteResources, localResources] = await Promise.all([scanRegistry(runtime), scanProject(ctx)]);
	const localKeys = new Set(localResources.map((entry) => resourceKey(entry.type, entry.name)));
	const targets = remoteResources.filter((entry) => matchesScope(entry.type, scope) && !localKeys.has(resourceKey(entry.type, entry.name)));
	if (targets.length === 0) {
		notify(ctx, `No ${scope === "all" ? "resources" : `${scope}s`} need installation.`);
		return;
	}
	for (const entry of targets) await installResourceWithRuntime(pi, ctx, runtime, entry.type, entry.name);
	notify(ctx, `Installed ${targets.length} registry resource${targets.length === 1 ? "" : "s"}. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function updateAll(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ResourceScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const statuses = (await collectStatuses(pi, ctx, runtime)).filter((status) => matchesScope(status.type, scope));
	const targets = statuses.filter((status) => status.kind === "update-available" || status.kind === "missing-local");
	const blocked = statuses.filter((status) => ["local-changes", "diverged", "registry-changed"].includes(status.kind));
	if (targets.length === 0) {
		notify(ctx, blocked.length > 0
			? `No safe updates available; ${blocked.length} resource${blocked.length === 1 ? " is" : "s are"} blocked by local/conflicting changes.`
			: `All tracked ${scope === "all" ? "resources are" : `${scope}s are`} up to date.`);
		return;
	}
	let updated = 0;
	for (const status of targets) {
		if (await updateResourceWithRuntime(pi, ctx, runtime, status.type, status.name) === "updated") updated += 1;
	}
	const suffix = blocked.length > 0 ? ` ${blocked.length} conflicting resource${blocked.length === 1 ? " was" : "s were"} skipped.` : "";
	notify(ctx, `Updated ${updated} registry resource${updated === 1 ? "" : "s"}.${suffix} Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function pushAll(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ResourceScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const targets = (await scanProject(ctx)).filter((entry) => matchesScope(entry.type, scope));
	if (targets.length === 0) {
		notify(ctx, `No project ${scope === "all" ? "resources" : `${scope}s`} found to push.`);
		return;
	}
	let changed = 0;
	let unchanged = 0;
	const failures: string[] = [];
	for (const entry of targets) {
		try {
			const result = await pushResourceWithRuntime(pi, ctx, runtime, entry.type, entry.name);
			if (result.changed) changed += 1;
			else unchanged += 1;
		} catch (error) {
			failures.push(`${entry.type} ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const summary = `Registry push all: ${changed} pushed, ${unchanged} unchanged, ${failures.length} failed.`;
	if (failures.length === 0) {
		notify(ctx, changed > 0 ? `${summary} Reloading resources…` : summary);
		if (changed > 0) await reloadAfterResourceChange(ctx);
		return;
	}
	pi.sendMessage({
		customType: SYSTEM_CUSTOM_MESSAGE_TYPE,
		content: [summary, "", ...failures.map((failure) => `- ${failure}`)].join("\n"),
		display: true,
		details: { kind: "resource-registry-bulk-push", userVisibleOnly: true },
	});
	notify(ctx, summary, "warning");
	if (changed > 0) await reloadAfterResourceChange(ctx);
}

async function removeAll(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: ResourceScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const targets = (await scanRegistry(runtime)).filter((entry) => matchesScope(entry.type, scope));
	if (targets.length === 0) {
		notify(ctx, `No registry ${scope === "all" ? "resources" : `${scope}s`} found to remove.`);
		return;
	}
	if (!ctx.hasUI) {
		throw new Error(`Bulk registry removal requires interactive confirmation. Run /${COMMAND} remove ${scope === "all" ? "all" : `${scope}s all`} in the UI.`);
	}
	const confirmed = await confirmOverwrite(
		ctx,
		"Remove registry resources",
		`Remove ${targets.length} ${scope === "all" ? "registry resources" : `registry ${scope}${targets.length === 1 ? "" : "s"}`}? Project copies will be kept.`,
	);
	if (!confirmed) {
		notify(ctx, "Bulk registry removal cancelled.");
		return;
	}

	const paths = targets.map((entry) => registryResourceRelativePath(entry.type, entry.name));
	for (const entry of targets) {
		await fs.rm(registryResourcePath(runtime.cacheDir, entry.type, entry.name), {
			recursive: entry.type === "skill",
			force: false,
		});
	}
	await runGit(pi, runtime.cacheDir, ["add", "-A", "--", ...paths]);
	const changed = (await runGit(pi, runtime.cacheDir, ["status", "--porcelain", "--", ...paths])).stdout.trim();
	if (!changed) throw new Error("Registry resources could not be staged for removal.");
	await runGit(pi, runtime.cacheDir, ["commit", "-m", `Remove ${targets.length} registry resource${targets.length === 1 ? "" : "s"}`, "--", ...paths]);
	try {
		await runGit(pi, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Bulk registry removal commit was created in the disposable cache but push failed; the remote registry is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}
	const revision = (await runGit(pi, runtime.cacheDir, ["rev-parse", "HEAD"])).stdout.trim();
	notify(ctx, `Removed ${targets.length} registry resource${targets.length === 1 ? "" : "s"} at ${revision.slice(0, 8)}. Project copies were kept. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function uninstallAll(ctx: ExtensionCommandContext, scope: ResourceScope): Promise<void> {
	const targets = (await scanProject(ctx)).filter((entry) => matchesScope(entry.type, scope));
	if (targets.length === 0) {
		notify(ctx, `No local project ${scope === "all" ? "resources" : `${scope}s`} found to uninstall.`);
		return;
	}
	if (!ctx.hasUI) {
		throw new Error(`Bulk local uninstall requires interactive confirmation. Run /${COMMAND} uninstall ${scope === "all" ? "all" : `${scope}s all`} in the UI.`);
	}
	const confirmed = await confirmOverwrite(
		ctx,
		"Uninstall local resources",
		`Remove ${targets.length} local ${scope === "all" ? "resources" : `${scope}${targets.length === 1 ? "" : "s"}`}? Registry copies will be kept.`,
	);
	if (!confirmed) {
		notify(ctx, "Bulk local uninstall cancelled.");
		return;
	}
	for (const entry of targets) {
		await fs.rm(entry.path, { recursive: entry.type === "skill", force: false });
	}
	await clearResourceProvenanceEntries(ctx, targets);
	notify(ctx, `Uninstalled ${targets.length} local resource${targets.length === 1 ? "" : "s"}. Registry copies were kept. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

function resourceLabel(entry: ResourceEntry): string {
	const description = truncate(entry.description, DESC_MAX);
	return description ? `${entry.name} — ${description}` : entry.name;
}

async function selectResource(ctx: ExtensionCommandContext, title: string, entries: ResourceEntry[]): Promise<ResourceEntry | undefined> {
	if (entries.length === 0) {
		notify(ctx, "No matching resources found.", "warning");
		return undefined;
	}
	if (!ctx.hasUI) {
		notify(ctx, entries.map((entry) => `${entry.type} ${entry.name}`).join("\n"));
		return undefined;
	}
	const labels = entries.map(resourceLabel);
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select(title, labels);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return undefined;
	}
	const index = selected ? labels.indexOf(selected) : -1;
	return index >= 0 ? entries[index] : undefined;
}

async function chooseType(ctx: ExtensionCommandContext, title: string): Promise<ResourceType | undefined> {
	if (!ctx.hasUI) return undefined;
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select(title, ["Skills", "Agents"]);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return undefined;
	}
	return selected === "Skills" ? "skill" : selected === "Agents" ? "agent" : undefined;
}

async function interactiveInstall(pi: ExtensionAPI, ctx: ExtensionCommandContext, forcedType?: ResourceType): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const type = forcedType ?? await chooseType(ctx, "Install from registry");
	if (!type) return;
	const entries = (await scanRegistry(runtime)).filter((entry) => entry.type === type);
	const selected = await selectResource(ctx, `Install ${type}`, entries);
	if (selected) await installResource(pi, ctx, type, selected.name);
}

async function interactivePush(pi: ExtensionAPI, ctx: ExtensionCommandContext, forcedType?: ResourceType): Promise<void> {
	const type = forcedType ?? await chooseType(ctx, "Push to registry");
	if (!type) return;
	const entries = (await scanProject(ctx)).filter((entry) => entry.type === type);
	const selected = await selectResource(ctx, `Push project ${type}`, entries);
	if (selected) await pushResource(pi, ctx, type, selected.name);
}

async function chooseProjectScope(ctx: ExtensionCommandContext, title: string): Promise<ProjectScope | undefined> {
	if (!ctx.hasUI) return undefined;
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select(title, ["Tasks + plans + TODO", "Tasks", "Plans", "TODO.md"]);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return undefined;
	}
	if (selected === "Tasks + plans + TODO") return "project";
	if (selected === "Tasks") return "tasks";
	if (selected === "Plans") return "plans";
	if (selected === "TODO.md") return "todo";
	return undefined;
}

async function interactiveProjectState(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: "push" | "pull"): Promise<void> {
	const scope = await chooseProjectScope(ctx, action === "push" ? "Push project state" : "Pull project state");
	if (!scope) return;
	if (action === "push") await pushProjectState(pi, ctx, scope);
	else await pullProjectState(pi, ctx, scope);
}

async function configureProjectKeyInteractive(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) throw new Error(`Usage: /${COMMAND} project-key <key|auto>`);
	const configured = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry.projectKey;
	let derived = "";
	if (!configured) {
		const origin = (await runGit(pi, ctx.cwd, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
		derived = projectKeyFromGitRemote(origin) ?? "";
	}
	let value: string | undefined;
	try {
		value = await ctx.ui.input("Project registry key (blank = auto from Git origin)", configured ?? derived);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	if (value === undefined) return;
	const trimmed = value.trim();
	await saveProjectKeyConfig(ctx.cwd, trimmed || undefined);
	if (trimmed) notify(ctx, `Project registry key set to ${trimmed}.`);
	else notify(ctx, `Project registry key override cleared; using ${await resolveProjectKey(pi, ctx.cwd)}.`);
}

async function interactiveRemove(pi: ExtensionAPI, ctx: ExtensionCommandContext, forcedType?: ResourceType): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const type = forcedType ?? await chooseType(ctx, "Remove from registry");
	if (!type) return;
	const entries = (await scanRegistry(runtime)).filter((entry) => entry.type === type);
	const selected = await selectResource(ctx, `Remove registry ${type}`, entries);
	if (!selected) return;
	const revision = await removeResourceWithRuntime(pi, ctx, runtime, type, selected.name);
	notify(ctx, `Removed ${type} "${selected.name}" from the registry at ${revision.slice(0, 8)}. Project copies were kept. Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

async function interactiveUninstall(ctx: ExtensionCommandContext, forcedType?: ResourceType): Promise<void> {
	const type = forcedType ?? await chooseType(ctx, "Uninstall local resource");
	if (!type) return;
	const entries = (await scanProject(ctx)).filter((entry) => entry.type === type);
	const selected = await selectResource(ctx, `Uninstall local ${type}`, entries);
	if (selected) await uninstallResource(ctx, type, selected.name);
}

async function interactiveUpdate(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const statuses = await collectStatuses(pi, ctx, runtime);
	const candidates = statuses.filter((status) => status.kind === "update-available" || status.kind === "missing-local");
	if (candidates.length === 0) {
		notify(ctx, "No safe registry updates are available.");
		return;
	}
	const labels = candidates.map((status) => `${statusIcon(status.kind)} ${status.type} ${status.name} — ${statusLabel(status.kind)}`);
	if (!ctx.hasUI) {
		notify(ctx, labels.join("\n"));
		return;
	}
	let selected: string | undefined;
	try {
		selected = await ctx.ui.select("Update from registry", labels);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	const index = selected ? labels.indexOf(selected) : -1;
	const status = index >= 0 ? candidates[index] : undefined;
	if (!status) return;
	const result = await updateResource(pi, ctx, status.type, status.name);
	if (result === "updated") {
		notify(ctx, `Updated ${status.type} "${status.name}". Reloading resources…`);
		await reloadAfterResourceChange(ctx);
	}
}

async function configureInteractive(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) throw new Error(`Usage: /${COMMAND} configure <git-url> [branch]`);
	const current: ResourceRegistryConfig = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
	let remote: string | undefined;
	let branch: string | undefined;
	try {
		remote = await ctx.ui.input("Resource registry Git remote", current.remote ?? "git@github.com:you/pix-resources.git");
		if (!remote?.trim()) return;
		branch = await ctx.ui.input("Registry branch", current.branch || "main");
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	await saveRegistryConfig(remote, branch?.trim() || "main");
	notify(ctx, `Registry configured: ${remote.trim()} (${branch?.trim() || "main"}).`);
}

async function showMainMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		notify(ctx, registryUsage());
		return;
	}
	let choice: string | undefined;
	try {
		choice = await ctx.ui.select("Resource registry", [
			"Status / check updates",
			"Install",
			"Update",
			"Push",
			"Uninstall local",
			"Push project state",
			"Pull project state",
			"Remove",
			"Configure project key",
			"Configure remote",
		]);
	} catch (error) {
		ignoreStaleExtensionContextError(error);
		return;
	}
	if (!choice) return;
	if (choice === "Configure remote") {
		await configureInteractive(ctx);
		return;
	}
	if (choice === "Install") {
		await interactiveInstall(pi, ctx);
		return;
	}
	if (choice === "Push") {
		await interactivePush(pi, ctx);
		return;
	}
	if (choice === "Uninstall local") {
		await interactiveUninstall(ctx);
		return;
	}
	if (choice === "Push project state") {
		await interactiveProjectState(pi, ctx, "push");
		return;
	}
	if (choice === "Pull project state") {
		await interactiveProjectState(pi, ctx, "pull");
		return;
	}
	if (choice === "Remove") {
		await interactiveRemove(pi, ctx);
		return;
	}
	if (choice === "Configure project key") {
		await configureProjectKeyInteractive(pi, ctx);
		return;
	}
	if (choice === "Update") {
		await interactiveUpdate(pi, ctx);
		return;
	}
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(pi, runtime);
	const [statuses, projectStatus] = await Promise.all([
		collectStatuses(pi, ctx, runtime),
		collectProjectStatuses(pi, ctx, runtime),
	]);
	sendStatusSystemMessage(pi, statuses, runtime, projectStatus);
}

function registryUsage(): string {
	return [
		"Resource registry",
		`/${COMMAND}                         open TUI`,
		`/${COMMAND} status                  fetch and show grouped reusable + project state`,
		`/${COMMAND} install skill <name>    install registry skill into .pi/skills`,
		`/${COMMAND} install agent <name>    install registry agent into .pi/agents`,
		`/${COMMAND} install all             install all missing skills and agents`,
		`/${COMMAND} install skills all      install all missing skills`,
		`/${COMMAND} install agents all      install all missing agents`,
		`/${COMMAND} update skill <name>     safely update an installed skill`,
		`/${COMMAND} update agent <name>     safely update an installed agent`,
		`/${COMMAND} update all              safely update all non-conflicting resources`,
		`/${COMMAND} update skills all       safely update all non-conflicting skills`,
		`/${COMMAND} update agents all       safely update all non-conflicting agents`,
		`/${COMMAND} push skill <name>       commit and push project skill to registry`,
		`/${COMMAND} push agent <name>       commit and push project agent to registry`,
		`/${COMMAND} push all                push all project skills and agents`,
		`/${COMMAND} push skills all         push all project skills`,
		`/${COMMAND} push agents all         push all project agents`,
		`/${COMMAND} push tasks              push .pi/${PROJECT_TASKS_FILE} under this project's registry key`,
		`/${COMMAND} push plans              push .pi/plans/ under this project's registry key`,
		`/${COMMAND} push todo               push .pi/${PROJECT_TODO_FILE} under this project's registry key`,
		`/${COMMAND} push project            push available ${PROJECT_TASKS_FILE} + plans + ${PROJECT_TODO_FILE} state`,
		`/${COMMAND} pull tasks              pull this project's ${PROJECT_TASKS_FILE} from the registry`,
		`/${COMMAND} pull plans              pull this project's plans/ from the registry`,
		`/${COMMAND} pull todo               pull this project's ${PROJECT_TODO_FILE} from the registry`,
		`/${COMMAND} pull project            pull available ${PROJECT_TASKS_FILE} + plans + ${PROJECT_TODO_FILE} state`,
		`/${COMMAND} remove skill <name>     remove a skill from the registry only`,
		`/${COMMAND} remove agent <name>     remove an agent from the registry only`,
		`/${COMMAND} remove all              remove all registry skills and agents (confirmation required)`,
		`/${COMMAND} remove skills all       remove all registry skills (confirmation required)`,
		`/${COMMAND} remove agents all       remove all registry agents (confirmation required)`,
		`/${COMMAND} uninstall skill <name>  remove a local .pi/skills copy only`,
		`/${COMMAND} uninstall agent <name>  remove a local .pi/agents copy only`,
		`/${COMMAND} uninstall all           remove all local skills and agents (confirmation required)`,
		`/${COMMAND} uninstall skills all    remove all local skills (confirmation required)`,
		`/${COMMAND} uninstall agents all    remove all local agents (confirmation required)`,
		`/${COMMAND} configure <url> [branch]`,
		`/${COMMAND} project-key [key|auto]  show/set project-scoped registry key`,
		`/${COMMAND} remote                  show configured remote`,
	].join("\n");
}

function parseAction(value: string | undefined): RegistryAction | undefined {
	if (value === "check") return "status";
	if (value === "config") return "configure";
	if (value === "delete" || value === "rm") return "remove";
	if (value === "remove-local" || value === "local-remove") return "uninstall";
	if (["install", "push", "pull", "remove", "uninstall", "status", "update", "configure", "remote", "project-key"].includes(value ?? "")) return value as RegistryAction;
	return undefined;
}

async function handleRpcCommand(
	pi: ExtensionAPI,
	parts: string[],
	ctx: ExtensionCommandContext,
): Promise<void> {
	const [action] = parts;
	if (!action || action === "refresh") {
		await publishRegistryUiSnapshot(pi, ctx);
		return;
	}
	if (!["install", "update", "push", "pull", "remove", "uninstall", "configure", "project-key"].includes(action)) {
		await publishRegistryUiSnapshot(pi, ctx, `Unsupported registry GUI action: ${action}`);
		return;
	}
	let error: string | undefined;
	try {
		if (action === "project-key" && parts.length === 1) await configureProjectKeyInteractive(pi, ctx);
		else await handleCommand(pi, parts.join(" "), ctx);
	} catch (actionError) {
		const message = actionError instanceof Error ? actionError.message : String(actionError);
		if (!/cancelled\.?$/i.test(message)) error = message;
	}
	await publishRegistryUiSnapshot(pi, ctx, error);
}

async function handleCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		await showMainMenu(pi, ctx);
		return;
	}
	if (parts[0] === "rpc") {
		await handleRpcCommand(pi, parts.slice(1), ctx);
		return;
	}
	if (parts[0] === "help" || parts[0] === "--help" || parts[0] === "-h") {
		notify(ctx, registryUsage());
		return;
	}
	const action = parseAction(parts[0]);
	if (!action) throw new Error(registryUsage());

	if (action === "configure") {
		const remote = parts[1];
		if (!remote) {
			await configureInteractive(ctx);
			return;
		}
		const branch = parts[2] ?? "main";
		await saveRegistryConfig(remote, branch);
		notify(ctx, `Registry configured: ${remote} (${branch}).`);
		return;
	}

	if (action === "remote") {
		const current = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry;
		if (!current.remote) {
			notify(ctx, `Registry is not configured. Run /${COMMAND} configure <git-url> [branch].`);
			return;
		}
		let key = "unavailable";
		try { key = await resolveProjectKey(pi, ctx.cwd); } catch { /* project state is optional */ }
		notify(ctx, `${current.remote} (${current.branch})\nProject key: ${key}`);
		return;
	}

	if (action === "project-key") {
		const value = parts[1];
		if (!value) {
			const configured = loadPiToolsSuiteConfig([], { cwd: ctx.cwd }).resourceRegistry.projectKey;
			const key = await resolveProjectKey(pi, ctx.cwd);
			notify(ctx, `${key}${configured ? " (configured)" : " (derived from Git origin)"}`);
			return;
		}
		if (value === "auto") {
			await saveProjectKeyConfig(ctx.cwd, undefined);
			notify(ctx, `Project registry key override cleared; using ${await resolveProjectKey(pi, ctx.cwd)}.`);
			return;
		}
		await saveProjectKeyConfig(ctx.cwd, value);
		notify(ctx, `Project registry key set to ${value}.`);
		return;
	}

	if (action === "status") {
		const runtime = loadRuntimeConfig(ctx.cwd);
		await ensureRegistryCache(pi, runtime);
		const [statuses, projectStatus] = await Promise.all([
			collectStatuses(pi, ctx, runtime),
			collectProjectStatuses(pi, ctx, runtime),
		]);
		sendStatusSystemMessage(pi, statuses, runtime, projectStatus);
		return;
	}

	if (action === "pull") {
		const scope = projectScope(parts[1]);
		if (scope) {
			await pullProjectState(pi, ctx, scope);
			return;
		}
		await interactiveProjectState(pi, ctx, "pull");
		return;
	}

	if (action === "push") {
		const scope = projectScope(parts[1]);
		if (scope) {
			await pushProjectState(pi, ctx, scope);
			return;
		}
	}

	if (action === "install" || action === "update" || action === "push" || action === "remove" || action === "uninstall") {
		const scope: ResourceScope | undefined = parts[1] === "all"
			? "all"
			: parts[2] === "all"
				? resourceType(parts[1])
				: undefined;
		if (scope) {
			if (action === "install") await installAll(pi, ctx, scope);
			else if (action === "update") await updateAll(pi, ctx, scope);
			else if (action === "push") await pushAll(pi, ctx, scope);
			else if (action === "remove") await removeAll(pi, ctx, scope);
			else await uninstallAll(ctx, scope);
			return;
		}
	}

	const type = resourceType(parts[1]);
	const name = parts[2];
	if (!type || !name) {
		if (action === "install") {
			await interactiveInstall(pi, ctx, type);
			return;
		}
		if (action === "push") {
			await interactivePush(pi, ctx, type);
			return;
		}
		if (action === "remove") {
			await interactiveRemove(pi, ctx, type);
			return;
		}
		if (action === "uninstall") {
			await interactiveUninstall(ctx, type);
			return;
		}
		if (action === "update") {
			await interactiveUpdate(pi, ctx);
			return;
		}
		throw new Error(registryUsage());
	}

	if (action === "install") {
		await installResource(pi, ctx, type, name);
		return;
	}
	if (action === "push") {
		await pushResource(pi, ctx, type, name);
		return;
	}
	if (action === "remove") {
		await removeResource(pi, ctx, type, name);
		return;
	}
	if (action === "uninstall") {
		await uninstallResource(ctx, type, name);
		return;
	}
	const result = await updateResource(pi, ctx, type, name);
	if (result === "current") {
		notify(ctx, `${type} "${name}" is already up to date.`);
		return;
	}
	notify(ctx, `Updated ${type} "${name}". Reloading resources…`);
	await reloadAfterResourceChange(ctx);
}

export default function resourceRegistry(pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		scheduleRegistryUiSnapshot(pi, ctx);
		if (event.reason === "startup") scheduleStartupUpdateCheck(pi, ctx);
	});

	pi.registerCommand(COMMAND, {
		description: "Install, update, push, uninstall locally, and remove remotely reusable skills/agents plus sync project-scoped tasks/plans/TODO through a private Git registry",
		handler: async (args: string, ctx) => {
			try {
				await handleCommand(pi, args, ctx);
			} catch (error) {
				try {
					ignoreStaleExtensionContextError(error);
				} catch (fatal) {
					notify(ctx, fatal instanceof Error ? fatal.message : String(fatal), "error");
				}
			}
		},
	});
}

export const __test = {
	collectRegistryUiSnapshot,
	collectStatuses,
	hashPath,
	loadRuntimeConfig,
	parseFrontmatterDescription,
	projectKeyFromGitRemote,
	registryResourceRelativePath,
	resourceKey,
	runStartupUpdateCheck,
	saveRegistryConfig,
	startupUpdateSummary,
};
