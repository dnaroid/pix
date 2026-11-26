import { join } from "node:path";
import { RegistryContext, RegistryExecutor, notify } from "./context.js";
import { PROJECT_DIR, PROJECT_PLANS_DIR, PROJECT_WORKSPACE_FILE, ProjectArtifact, ProjectProvenanceEntry, REGISTRY_PROJECTS_DIR, RegistryRuntime, canonicalPlanFileName } from "./model.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, projectArtifactRevision, resolveProjectKey } from "./git.js";
import { readProvenance, recordProjectProvenance } from "./provenance.js";
import { pathExists, projectArtifactLocalPath, projectArtifactRegistryPath, projectArtifactRelativePaths } from "./paths.js";
import { hashProjectArtifactLocal, hashProjectArtifactRemote } from "./task-bundle.js";
import { hashPath } from "./resource-files.js";
import { localTasksExist } from "./task-database.js";
import { collectRegistryFileDiff, RegistryDiffFile } from "./diff.js";
import { applyTreeMerge, assertNoConflictMarkers, conflictSummary, materializeRevision, mergePreviewFiles, mergeTrees, withMergeWorkspace, type TreeMergeResult } from "./merge.js";
import { replaceWorkspaceConfig } from "../search/source-policy.js";

type ProjectSides = {
	runtime: RegistryRuntime;
	projectKey: string;
	artifact: ProjectArtifact;
	tracked: ProjectProvenanceEntry;
	remoteRevision: string;
	localHash: string;
	remoteHash: string;
};

const TASKS_NOT_MERGEABLE = "Project tasks are stored in a database and cannot be merged file by file. Compare both copies and choose Mark as merged to keep the local tasks, then Push.";

function artifactRoot(artifact: Exclude<ProjectArtifact, "tasks">): string {
	return artifact === "plans" ? PROJECT_PLANS_DIR : PROJECT_WORKSPACE_FILE;
}

function artifactFilter(artifact: ProjectArtifact): ((name: string) => boolean) | undefined {
	return artifact === "plans" ? canonicalPlanFileName : undefined;
}

async function projectSides(executor: RegistryExecutor, ctx: RegistryContext, artifact: ProjectArtifact): Promise<ProjectSides> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const projectKey = await resolveProjectKey(executor, ctx.cwd);
	const tracked = (await readProvenance(ctx)).projectResources[artifact];
	if (!tracked) throw new Error(`Project ${artifact} state is not tracked by the registry, so it has no baseline to merge from.`);
	if (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey) {
		throw new Error(`${artifact} state is tracked under another registry/branch/project key. Check Registry before merging.`);
	}
	if (!(await pathExists(projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact)))) {
		throw new Error(`Registry has no ${artifact} state for project ${projectKey}.`);
	}
	const localExists = artifact === "tasks" ? await localTasksExist(ctx.cwd) : await pathExists(projectArtifactLocalPath(ctx.cwd, artifact));
	if (!localExists) throw new Error(`Project ${artifact} state does not exist locally.`);
	const remoteRevision = await projectArtifactRevision(executor, runtime, projectKey, artifact);
	if (!remoteRevision) throw new Error(`Cannot determine registry revision for project ${artifact} state.`);
	const [localHash, remoteHash] = await Promise.all([
		hashProjectArtifactLocal(ctx.cwd, artifact),
		hashProjectArtifactRemote(runtime, projectKey, artifact),
	]);
	return { runtime, projectKey, artifact, tracked, remoteRevision, localHash, remoteHash };
}

/** Project status tracks the registry by revision; mirror it so actions match the displayed state. */
function assertDiverged(sides: ProjectSides): void {
	if (sides.localHash === sides.tracked.hash) throw new Error(`Project ${sides.artifact} state has no local changes; use Pull to take the registry version.`);
	if (sides.remoteRevision === sides.tracked.revision) throw new Error(`Project ${sides.artifact} state has not changed in the registry; use Push to publish the local changes.`);
}

async function computeProjectMerge(executor: RegistryExecutor, ctx: RegistryContext, sides: ProjectSides, work: string): Promise<TreeMergeResult> {
	const { runtime, projectKey, artifact, tracked } = sides;
	if (artifact === "tasks") throw new Error(TASKS_NOT_MERGEABLE);
	const baseDir = join(work, "base");
	await materializeRevision(executor, runtime.cacheDir, tracked.revision, projectArtifactRelativePaths(projectKey, artifact), baseDir);
	const baseRoot = join(baseDir, REGISTRY_PROJECTS_DIR, projectKey);
	const root = artifactRoot(artifact);
	const basePath = join(baseRoot, root);
	if (!(await pathExists(basePath)) || await hashPath(basePath, artifact === "plans" ? "plans" : "resource") !== tracked.hash) {
		throw new Error(`Registry revision ${tracked.revision.slice(0, 8)} does not contain the baseline recorded for project ${artifact} state, so it cannot be merged automatically. Compare both copies and choose Mark as merged if the local copy already includes the registry changes.`);
	}
	const filter = artifactFilter(artifact);
	return mergeTrees(executor, {
		roots: [root],
		base: baseRoot,
		ours: join(ctx.cwd, PROJECT_DIR),
		theirs: join(runtime.cacheDir, REGISTRY_PROJECTS_DIR, projectKey),
		...(filter ? { acceptFile: filter } : {}),
	}, work);
}

async function assertLocalUnchanged(ctx: RegistryContext, sides: ProjectSides): Promise<void> {
	if (await hashProjectArtifactLocal(ctx.cwd, sides.artifact) !== sides.localHash) {
		throw new Error(`Project ${sides.artifact} state changed while merging; no files were written. Retry Merge.`);
	}
}

/** Read-only preview: old side is the project copy, new side the merge result. */
export async function previewProjectMerge(executor: RegistryExecutor, ctx: RegistryContext, artifact: ProjectArtifact): Promise<RegistryDiffFile[]> {
	const sides = await projectSides(executor, ctx, artifact);
	if (sides.localHash === sides.remoteHash) return [];
	assertDiverged(sides);
	return withMergeWorkspace(async (work) => mergePreviewFiles((await computeProjectMerge(executor, ctx, sides, work)).changes));
}

/** Read-only Registry → Local comparison shown before Mark as merged. */
export async function compareProjectArtifact(executor: RegistryExecutor, ctx: RegistryContext, artifact: ProjectArtifact): Promise<RegistryDiffFile[]> {
	if (artifact === "tasks") throw new Error("Project tasks are stored in a database; a file comparison is not available.");
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const projectKey = await resolveProjectKey(executor, ctx.cwd);
	return collectRegistryFileDiff(join(runtime.cacheDir, REGISTRY_PROJECTS_DIR, projectKey), join(ctx.cwd, PROJECT_DIR), [artifactRoot(artifact)], artifactFilter(artifact));
}

/** Three-way merge of diverged plans/workspace state; see mergeResource for the baseline rules. */
export async function mergeProjectArtifact(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	artifact: ProjectArtifact,
	options: { writeConflictMarkers?: boolean } = {},
): Promise<void> {
	const sides = await projectSides(executor, ctx, artifact);
	if (sides.localHash === sides.remoteHash) {
		await recordProjectProvenance(ctx, sides.runtime, sides.projectKey, artifact, sides.remoteRevision, sides.remoteHash);
		notify(ctx, `Project ${artifact} state already matches the registry.`);
		return;
	}
	assertDiverged(sides);
	await withMergeWorkspace(async (work) => {
		const result = await computeProjectMerge(executor, ctx, sides, work);
		if (result.conflicts.length > 0) {
			const count = result.conflicts.length;
			const summary = conflictSummary(result.conflicts);
			// Markers would make workspace.jsonc unparseable and break project settings.
			if (!options.writeConflictMarkers || artifact === "workspace") {
				throw new Error(`Merge of project ${artifact} state stopped with ${count} conflicting file(s): ${summary}. No files were written. ${artifact === "workspace"
					? "Edit .pi/workspace.jsonc to include the registry changes, then choose Mark as merged."
					: "Write conflict markers from the merge preview, or resolve manually and choose Mark as merged."}`);
			}
			await assertLocalUnchanged(ctx, sides);
			await applyTreeMerge(join(ctx.cwd, PROJECT_DIR), result.changes, true);
			notify(ctx, `Wrote conflict markers into ${count} project plan file(s). Resolve them, then choose Mark as merged.`, "warning");
			return;
		}
		if (artifact === "workspace") {
			const change = result.changes[0];
			if (change?.merged) {
				const content = change.merged.toString("utf8");
				await replaceWorkspaceConfig(ctx.cwd, content, () => assertLocalUnchanged(ctx, sides));
			}
		} else {
			await assertLocalUnchanged(ctx, sides);
			await applyTreeMerge(join(ctx.cwd, PROJECT_DIR), result.changes, false);
		}
		await recordProjectProvenance(ctx, sides.runtime, sides.projectKey, artifact, sides.remoteRevision, sides.remoteHash);
		notify(ctx, `Merged registry changes into project ${artifact} state. Push to publish the combined copy.`);
	});
}

/** The user confirms the local state already includes the registry changes; local files are kept. */
export async function markProjectArtifactMerged(executor: RegistryExecutor, ctx: RegistryContext, artifact: ProjectArtifact): Promise<void> {
	const sides = await projectSides(executor, ctx, artifact);
	if (sides.localHash !== sides.remoteHash) assertDiverged(sides);
	if (artifact !== "tasks") await assertNoConflictMarkers(join(ctx.cwd, PROJECT_DIR), [artifactRoot(artifact)], artifactFilter(artifact));
	await recordProjectProvenance(ctx, sides.runtime, sides.projectKey, artifact, sides.remoteRevision, sides.remoteHash);
	notify(ctx, sides.localHash === sides.remoteHash
		? `Project ${artifact} state already matches the registry.`
		: `Marked project ${artifact} state as merged with registry revision ${sides.remoteRevision.slice(0, 8)}. Push to publish the local copy.`);
}
