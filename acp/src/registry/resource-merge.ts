import { join } from "node:path";
import { RegistryContext, RegistryExecutor, notify } from "./context.js";
import { PROJECT_DIR, REGISTRY_AGENTS_DIR, REGISTRY_SKILLS_DIR, RegistryRuntime, ResourceType, ProvenanceEntry } from "./model.js";
import { pathExists, projectResourcePath, registryResourceNamespace, registryResourcePath, registryResourceRelativePath, resourceKey, validateName } from "./paths.js";
import { hashResource } from "./resource-files.js";
import { ensureRegistryCache, resourceRevision } from "./git.js";
import { readProvenance, recordProvenance } from "./provenance.js";
import { loadRuntimeConfig } from "./config.js";
import { samePublication, selectPublicationRuntime } from "./publication-location.js";
import { RegistryDiffFile } from "./diff.js";
import { applyTreeMerge, assertNoConflictMarkers, conflictSummary, materializeRevision, mergePreviewFiles, mergeTrees, withMergeWorkspace, type TreeMergeResult } from "./merge.js";

type ResourceSides = {
	runtime: RegistryRuntime;
	tracked: ProvenanceEntry;
	type: ResourceType;
	name: string;
	localPath: string;
	remoteRevision: string;
	localHash: string;
	remoteHash: string;
};

function resourceRoots(type: ResourceType, name: string): string[] {
	return type === "skill"
		? [`${REGISTRY_SKILLS_DIR}/${name}`]
		: [`${REGISTRY_AGENTS_DIR}/${name}.md`, `${REGISTRY_AGENTS_DIR}/${name}`];
}

async function resourceSides(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<ResourceSides> {
	validateName(name);
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name);
	const tracked = (await readProvenance(ctx)).resources[resourceKey(type, name)];
	if (!tracked) throw new Error(`${type} "${name}" is not tracked by the registry, so it has no baseline to merge from.`);
	if (!samePublication(tracked, runtime)) {
		throw new Error(`${type} "${name}" was installed from ${tracked.remote} (${tracked.branch}); current registry is ${runtime.remote} (${runtime.branch}).`);
	}
	const remotePath = registryResourcePath(runtime.cacheDir, type, name, runtime);
	if (!(await pathExists(remotePath))) throw new Error(`${type} "${name}" was removed from the registry.`);
	const localPath = projectResourcePath(ctx, type, name);
	if (!(await pathExists(localPath))) throw new Error(`Project ${type} "${name}" does not exist.`);
	const remoteRevision = await resourceRevision(executor, runtime, type, name);
	if (!remoteRevision) throw new Error(`Cannot determine registry revision for ${type} "${name}".`);
	const [localHash, remoteHash] = await Promise.all([hashResource(type, localPath), hashResource(type, remotePath)]);
	return { runtime, tracked, type, name, localPath, remoteRevision, localHash, remoteHash };
}

/** Both copies left the recorded baseline; otherwise Update or Push is the right action. */
function assertDiverged(sides: ResourceSides): void {
	const { tracked, type, name } = sides;
	if (sides.localHash === tracked.hash) throw new Error(`${type} "${name}" has no local changes; use Update to take the registry version.`);
	if (sides.remoteHash === tracked.hash) throw new Error(`${type} "${name}" has not changed in the registry; use Push to publish the local changes.`);
}

async function computeResourceMerge(executor: RegistryExecutor, ctx: RegistryContext, sides: ResourceSides, work: string): Promise<TreeMergeResult> {
	const { runtime, tracked, type, name } = sides;
	const rel = registryResourceRelativePath(type, name, runtime);
	const baseDir = join(work, "base");
	await materializeRevision(executor, runtime.cacheDir, tracked.revision, type === "agent" ? [rel, rel.slice(0, -3)] : [rel], baseDir);
	const namespace = registryResourceNamespace(runtime);
	const baseRoot = namespace ? join(baseDir, ...namespace.split("/")) : baseDir;
	const roots = resourceRoots(type, name);
	const basePath = join(baseRoot, ...roots[0]!.split("/"));
	// The baseline is the copy this project last synced; a mismatch means the
	// recorded revision cannot reproduce it and any merge would be guesswork.
	if (!(await pathExists(basePath)) || await hashResource(type, basePath) !== tracked.hash) {
		throw new Error(`Registry revision ${tracked.revision.slice(0, 8)} does not contain the baseline recorded for ${type} "${name}", so it cannot be merged automatically. Review Compare and choose Mark as merged if the local copy already includes the registry changes.`);
	}
	return mergeTrees(executor, {
		roots,
		base: baseRoot,
		ours: join(ctx.cwd, PROJECT_DIR),
		theirs: namespace ? join(runtime.cacheDir, ...namespace.split("/")) : runtime.cacheDir,
	}, work);
}

async function assertLocalUnchanged(sides: ResourceSides): Promise<void> {
	if (await hashResource(sides.type, sides.localPath) !== sides.localHash) {
		throw new Error(`Project ${sides.type} "${sides.name}" changed while merging; no files were written. Retry Merge.`);
	}
}

/** Read-only merge preview: old side is the project copy, new side the merge result. */
export async function previewResourceMerge(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<RegistryDiffFile[]> {
	const sides = await resourceSides(executor, ctx, type, name);
	if (sides.localHash === sides.remoteHash) return [];
	assertDiverged(sides);
	return withMergeWorkspace(async (work) => mergePreviewFiles((await computeResourceMerge(executor, ctx, sides, work)).changes));
}

/**
 * Three-way merge of a diverged resource into the project copy. A clean merge
 * adopts the registry revision as the new baseline (status becomes local
 * changes, ready to push). Conflicts write nothing unless the caller
 * explicitly asks for conflict markers; the baseline then moves only via
 * Mark as merged after manual resolution.
 */
export async function mergeResource(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	type: ResourceType,
	name: string,
	options: { writeConflictMarkers?: boolean } = {},
): Promise<void> {
	const sides = await resourceSides(executor, ctx, type, name);
	const oursRoot = join(ctx.cwd, PROJECT_DIR);
	if (sides.localHash === sides.remoteHash) {
		await recordProvenance(ctx, sides.runtime, type, name, sides.remoteRevision, sides.remoteHash);
		notify(ctx, `${type} "${name}" already matches the registry.`);
		return;
	}
	assertDiverged(sides);
	await withMergeWorkspace(async (work) => {
		const result = await computeResourceMerge(executor, ctx, sides, work);
		if (result.conflicts.length > 0) {
			const count = result.conflicts.length;
			const summary = conflictSummary(result.conflicts);
			if (!options.writeConflictMarkers) {
				throw new Error(`Merge of ${type} "${name}" stopped with ${count} conflicting file(s): ${summary}. No files were written. Write conflict markers from the merge preview, or resolve manually and choose Mark as merged.`);
			}
			await assertLocalUnchanged(sides);
			await applyTreeMerge(oursRoot, result.changes, true);
			notify(ctx, `Wrote conflict markers into ${count} file(s) of ${type} "${name}". Resolve them, then choose Mark as merged.`, "warning");
			return;
		}
		await assertLocalUnchanged(sides);
		await applyTreeMerge(oursRoot, result.changes, false);
		await recordProvenance(ctx, sides.runtime, type, name, sides.remoteRevision, sides.remoteHash);
		notify(ctx, `Merged registry changes into ${type} "${name}". Push to publish the combined copy.`);
	});
}

/**
 * The user confirms the project copy already contains the registry changes:
 * the current registry revision becomes the baseline; local files are kept.
 */
export async function markResourceMerged(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	const sides = await resourceSides(executor, ctx, type, name);
	if (sides.localHash !== sides.remoteHash) assertDiverged(sides);
	await assertNoConflictMarkers(join(ctx.cwd, PROJECT_DIR), resourceRoots(type, name));
	await recordProvenance(ctx, sides.runtime, type, name, sides.remoteRevision, sides.remoteHash);
	notify(ctx, sides.localHash === sides.remoteHash
		? `${type} "${name}" already matches the registry.`
		: `Marked ${type} "${name}" as merged with registry revision ${sides.remoteRevision.slice(0, 8)}. Push to publish the local copy.`);
}
