import type { RegistryExecutor } from "./context.js";
import { resolveProjectKey } from "./git.js";
import { SKIP_NAMES, type ProvenanceEntry, type RegistryRuntime, type ResourceType } from "./model.js";
import { pathExists, projectCwd, registryResourcePath, validateName, type ProjectContext } from "./paths.js";
import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";

export async function assertPublicationDirectories(runtime: RegistryRuntime): Promise<void> {
	const roots = [runtime.cacheDir];
	if (runtime.projectKey) roots.push(join(runtime.cacheDir, "projects"), join(runtime.cacheDir, "projects", runtime.projectKey));
	for (const root of [...roots, ...roots.flatMap((dir) => [join(dir, "skills"), join(dir, "agents")])]) {
		try {
			const stat = await fs.lstat(root);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Invalid publication directory (symbolic links are not allowed): ${root}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
}

/** Global publication must not shadow any project's same-named definition. */
export async function assertOtherProjectsAbsent(runtime: RegistryRuntime, type: ResourceType, name: string): Promise<void> {
	let projects: Dirent[];
	try { projects = await fs.readdir(join(runtime.cacheDir, "projects"), { withFileTypes: true }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	for (const project of projects) {
		if (SKIP_NAMES.has(project.name)) continue;
		// Incidental files are not namespaces; symlink namespaces still fail closed.
		if (!project.isDirectory() && !project.isSymbolicLink()) continue;
		const projectKey = project.name;
		if (projectKey === runtime.projectKey) continue;
		validateName(projectKey);
		const other: RegistryRuntime = { ...runtime, projectKey, publicationScope: "project" };
		await assertPublicationDirectories(other);
		const file = registryResourcePath(runtime.cacheDir, type, name, other);
		const companion = type === "agent" ? file.slice(0, -3) : undefined;
		if (await pathExists(file) || (companion && await pathExists(companion))) {
			throw new Error(`Publication name collision: ${type} "${name}" already exists in another Project scope. Neither copy was overwritten.`);
		}
	}
}

/** A missing project key must not prevent use of the shared catalog. */
export async function resolvePublicationProjectKey(executor: RegistryExecutor, project: ProjectContext): Promise<string | undefined> {
	try { return await resolveProjectKey(executor, projectCwd(project)); }
	catch { return undefined; }
}

/** Select the one visible publication, never silently shadow same-named resources. */
export async function selectPublicationRuntime(
	executor: RegistryExecutor, project: ProjectContext, runtime: RegistryRuntime, type: ResourceType, name: string,
	newPublicationScope: "global" | "project" = "global",
): Promise<RegistryRuntime> {
	const projectKey = await resolvePublicationProjectKey(executor, project);
	const global: RegistryRuntime = { ...runtime, publicationScope: "global", ...(projectKey ? { projectKey } : {}) };
	await assertPublicationDirectories(global);
	const scoped: RegistryRuntime = { ...runtime, publicationScope: "project", ...(projectKey ? { projectKey } : {}) };
	const globalExists = await pathExists(registryResourcePath(runtime.cacheDir, type, name, global));
	const projectExists = Boolean(projectKey) && await pathExists(registryResourcePath(runtime.cacheDir, type, name, scoped));
	if (globalExists && projectExists) throw new Error(`Publication name collision: ${type} "${name}" exists in both Global and Project scopes. Resolve the collision without overwriting either copy.`);
	if (!globalExists && !projectExists && newPublicationScope === "project") {
		if (!projectKey) throw new Error("Project publication requires a project key. Set a key in Registry; Git is optional.");
		return scoped;
	}
	return projectExists ? scoped : global;
}

export function samePublication(tracked: ProvenanceEntry, runtime: RegistryRuntime): boolean {
	return tracked.remote === runtime.remote && tracked.branch === runtime.branch
		&& (tracked.publicationScope ?? "global") === (runtime.publicationScope ?? "global")
		&& (tracked.publicationScope !== "project" || tracked.projectKey === runtime.projectKey);
}
