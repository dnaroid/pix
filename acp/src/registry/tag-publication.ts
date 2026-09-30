import { join } from "node:path";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { resourceRevision, runGit } from "./git.js";
import { saveResourceTags } from "./metadata.js";
import { SKILL_FILE, type RegistryRuntime, type ResourceType } from "./model.js";
import { registryResourcePath, registryResourceRelativePath } from "./paths.js";
import { recordProvenance } from "./provenance.js";
import { hashResource } from "./resource-files.js";

/** Sync metadata only; unrelated local body/assets must not be published implicitly. */
export async function publishResourceTags(
	executor: RegistryExecutor, ctx: RegistryContext, runtime: RegistryRuntime,
	type: ResourceType, name: string, tags: readonly string[],
): Promise<void> {
	const resource = registryResourcePath(runtime.cacheDir, type, name, runtime);
	const file = type === "skill" ? join(resource, SKILL_FILE) : resource;
	if (await saveResourceTags(runtime.cacheDir, file, tags)) {
		const relative = registryResourceRelativePath(type, name, runtime);
		const metadataPath = type === "skill" ? `${relative}/${SKILL_FILE}` : relative;
		await runGit(executor, runtime.cacheDir, ["add", "--", metadataPath]);
		await runGit(executor, runtime.cacheDir, ["commit", "-m", `Update ${type} ${name} tags`, "--", metadataPath]);
		await runGit(executor, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	}
	const revision = await resourceRevision(executor, runtime, type, name);
	// Baseline published bytes, not unsynced local changes that may still exist.
	if (!revision) throw new Error(`Published ${type} ${name} has no remote revision.`);
	await recordProvenance(ctx, runtime, type, name, revision, await hashResource(type, resource));
}
