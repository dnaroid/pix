import { RegistryExecutor } from "./context.js";
import { ProjectContext, pathExists, projectCwd, registryResourceNamespace, validateName } from "./paths.js";
import { PROJECT_DIR, REGISTRY_AGENTS_DIR, REGISTRY_SKILLS_DIR, ResourceType } from "./model.js";
import { RegistryDiffPayload, collectRegistryFileDiff } from "./diff.js";
import { loadRuntimeConfig, registryUiCacheRoot } from "./config.js";
import { ensureRegistryCache } from "./git.js";
import { join } from "node:path";
import { selectPublicationRuntime } from "./publication-location.js";

export async function collectRegistryDiff(
	executor: RegistryExecutor,
	project: ProjectContext,
	type: ResourceType,
	name: string,
): Promise<RegistryDiffPayload> {
	validateName(name);
	const cwd = projectCwd(project);
	let runtime = { ...loadRuntimeConfig(cwd), cacheDir: registryUiCacheRoot() };
	return (async () => {
		await ensureRegistryCache(executor, runtime);
		runtime = await selectPublicationRuntime(executor, project, runtime, type, name);
		const oldBase = join(runtime.cacheDir, registryResourceNamespace(runtime));
		const newBase = join(cwd, PROJECT_DIR);
		const primary = type === "skill" ? `${REGISTRY_SKILLS_DIR}/${name}` : `${REGISTRY_AGENTS_DIR}/${name}.md`;
		if (!(await pathExists(join(oldBase, ...primary.split("/"))))) throw new Error(`${type} "${name}" does not exist in the registry.`);
		if (!(await pathExists(join(newBase, ...primary.split("/"))))) throw new Error(`Project ${type} "${name}" does not exist.`);
		const roots = type === "skill"
			? [primary]
			: [primary, `${REGISTRY_AGENTS_DIR}/${name}`];
		return {
			version: 1,
			type,
			name,
			files: await collectRegistryFileDiff(oldBase, newBase, roots),
		};
	})();
}
