import { PROJECT_AGENTS_DIR, PROJECT_DIR, PROJECT_PLANS_DIR, PROJECT_SKILLS_DIR, PROJECT_TASKS_FILE, PROJECT_TASK_ATTACHMENTS_DIR, PROJECT_TODO_FILE, PROJECT_WORKSPACE_FILE, ProjectArtifact, ProjectScope, REGISTRY_AGENTS_DIR, REGISTRY_PROJECTS_DIR, REGISTRY_SKILLS_DIR, RegistryRuntime, ResourceScope, ResourceType, SAFE_BRANCH, SAFE_NAME, canonicalPlanFileName, canonicalRegistryEntryName } from "./model.js";
import { RegistryContext } from "./context.js";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export function truncate(value: string, maxLength: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= maxLength ? collapsed : `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function resourceKey(type: ResourceType, name: string): string {
	return `${type}:${name}`;
}

export function resourceType(value: string | undefined): ResourceType | undefined {
	if (value === "skill" || value === "skills") return "skill";
	if (value === "agent" || value === "agents") return "agent";
	return undefined;
}

export function matchesScope(type: ResourceType, scope: ResourceScope): boolean {
	return scope === "all" || type === scope;
}

export function projectScope(value: string | undefined): ProjectScope | undefined {
	if (value === "tasks") return "tasks";
	if (value === "plans") return "plans";
	if (value === "todo") return "todo";
	if (value === "workspace") return "workspace";
	if (value === "project") return "project";
	return undefined;
}

export type ProjectContext = RegistryContext | string;

export function projectCwd(project: ProjectContext): string {
	return typeof project === "string" ? project : project.cwd;
}

export function validateName(name: string): void {
	if (!SAFE_NAME.test(name) || name === "." || name === ".." || name.includes("..")) {
		throw new Error(`Invalid resource name "${name}". Use letters, digits, dot, underscore, or dash.`);
	}
}

export function validateBranch(branch: string): void {
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

export function projectResourcePath(ctx: RegistryContext, type: ResourceType, name: string): string {
	validateName(name);
	return type === "skill"
		? join(ctx.cwd, PROJECT_DIR, PROJECT_SKILLS_DIR, name)
		: join(ctx.cwd, PROJECT_DIR, PROJECT_AGENTS_DIR, `${name}.md`);
}

export function registryResourceNamespace(runtime?: RegistryRuntime): string {
	if (runtime?.publicationScope !== "project") return "";
	if (!runtime.projectKey) throw new Error("Project publication requires a project key.");
	validateName(runtime.projectKey);
	return `${REGISTRY_PROJECTS_DIR}/${runtime.projectKey}`;
}

export function registryResourceRelativePath(type: ResourceType, name: string, runtime?: RegistryRuntime): string {
	validateName(name);
	const resource = type === "skill" ? `${REGISTRY_SKILLS_DIR}/${name}` : `${REGISTRY_AGENTS_DIR}/${name}.md`;
	const namespace = registryResourceNamespace(runtime);
	return namespace ? `${namespace}/${resource}` : resource;
}

export function registryResourcePath(cacheDir: string, type: ResourceType, name: string, runtime?: RegistryRuntime): string {
	return join(cacheDir, ...registryResourceRelativePath(type, name, runtime).split("/"));
}

export function projectArtifactLocalPath(cwd: string, artifact: ProjectArtifact): string {
	switch (artifact) {
		case "tasks": return join(cwd, PROJECT_DIR, PROJECT_TASKS_FILE);
		case "plans": return join(cwd, PROJECT_DIR, PROJECT_PLANS_DIR);
		case "todo": return join(cwd, PROJECT_DIR, PROJECT_TODO_FILE);
		case "workspace": return join(cwd, PROJECT_DIR, PROJECT_WORKSPACE_FILE);
	}
}

export function projectTaskAttachmentsLocalPath(cwd: string): string {
	return join(cwd, PROJECT_DIR, PROJECT_TASK_ATTACHMENTS_DIR);
}

export function projectArtifactRelativePath(projectKey: string, artifact: ProjectArtifact): string {
	validateName(projectKey);
	switch (artifact) {
		case "tasks": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_TASKS_FILE}`;
		case "plans": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_PLANS_DIR}`;
		case "todo": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_TODO_FILE}`;
		case "workspace": return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_WORKSPACE_FILE}`;
	}
}

export function projectTaskAttachmentsRelativePath(projectKey: string): string {
	validateName(projectKey);
	return `${REGISTRY_PROJECTS_DIR}/${projectKey}/${PROJECT_TASK_ATTACHMENTS_DIR}`;
}

export function projectArtifactRelativePaths(projectKey: string, artifact: ProjectArtifact): string[] {
	const primary = projectArtifactRelativePath(projectKey, artifact);
	return artifact === "tasks"
		? [primary, projectTaskAttachmentsRelativePath(projectKey)]
		: [primary];
}

export function projectArtifactDisplayName(artifact: ProjectArtifact): string {
	switch (artifact) {
		case "tasks": return PROJECT_TASKS_FILE;
		case "plans": return `${PROJECT_PLANS_DIR}/`;
		case "todo": return PROJECT_TODO_FILE;
		case "workspace": return PROJECT_WORKSPACE_FILE;
	}
}

export function projectArtifactRegistryPath(cacheDir: string, projectKey: string, artifact: ProjectArtifact): string {
	return join(cacheDir, ...projectArtifactRelativePath(projectKey, artifact).split("/"));
}

export function projectTaskAttachmentsRegistryPath(cacheDir: string, projectKey: string): string {
	return join(cacheDir, ...projectTaskAttachmentsRelativePath(projectKey).split("/"));
}

export function canonicalGitRemote(remote: string): string | undefined {
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

export function projectKeyFromGitRemote(remote: string): string | undefined {
	const canonical = canonicalGitRemote(remote);
	if (!canonical) return undefined;
	const key = canonical
		.split("/")
		.map((part) => part.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, ""))
		.filter(Boolean)
		.join("__");
	return key && SAFE_NAME.test(key) && !key.includes("..") ? key : undefined;
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

export async function hasTrackableFiles(path: string): Promise<boolean> {
	const stat = await fs.lstat(path);
	if (stat.isFile() || stat.isSymbolicLink()) return canonicalPlanFileName(basename(path));
	if (!stat.isDirectory()) return false;
	for (const entry of await fs.readdir(path, { withFileTypes: true })) {
		if (!canonicalRegistryEntryName(entry.name)) continue;
		if ((entry.isFile() || entry.isSymbolicLink()) && canonicalPlanFileName(entry.name)) return true;
		if (entry.isDirectory() && await hasTrackableFiles(join(path, entry.name))) return true;
	}
	return false;
}
