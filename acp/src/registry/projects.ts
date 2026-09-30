import { RegistryContext, RegistryExecutor, confirmOverwrite, notify } from "./context.js";
import { PROJECT_PLANS_DIR, PROJECT_TASKS_FILE, PROJECT_TODO_FILE, ProjectArtifact, ProjectScope, REGISTRY_PROJECTS_DIR } from "./model.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, projectArtifactRevision, resolveProjectKey, runGit } from "./git.js";
import { projectArtifacts } from "./status.js";
import { clearProjectProvenanceEntries, readProvenance, recordProjectProvenance } from "./provenance.js";
import { hasTrackableFiles, pathExists, projectArtifactDisplayName, projectArtifactLocalPath, projectArtifactRegistryPath } from "./paths.js";
import { hashProjectArtifactLocal, hashProjectArtifactRemote, replaceLocalTaskBundle, replaceRemoteTaskBundle } from "./task-bundle.js";
import { promises as fs } from "node:fs";
import { replaceResource } from "./resource-files.js";

export async function pushProjectState(executor: RegistryExecutor, ctx: RegistryContext, scope: ProjectScope, silent = false): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const projectKey = await resolveProjectKey(executor, ctx.cwd);
	const requested = projectArtifacts(scope);
	const provenance = await readProvenance(ctx);
	const targets: Array<{ artifact: ProjectArtifact; deleteRemote: boolean }> = [];
	const alreadyAbsent: ProjectArtifact[] = [];
	for (const artifact of requested) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		if (await pathExists(localPath)) {
			if (artifact === "plans" && !(await hasTrackableFiles(localPath))) {
				const tracked = provenance.projectResources[artifact];
				if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
					throw new Error(`${artifact} state is tracked under another registry/branch/project key. Check Registry before pushing.`);
				}
				if (await pathExists(projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact))) {
					targets.push({ artifact, deleteRemote: true });
				} else {
					alreadyAbsent.push(artifact);
				}
				continue;
			}
			targets.push({ artifact, deleteRemote: false });
		} else if (scope !== "project") {
			throw new Error(`Project .pi/${projectArtifactDisplayName(artifact)} does not exist.`);
		}
	}
	if (targets.length === 0) {
		await clearProjectProvenanceEntries(ctx, alreadyAbsent);
		if (silent) return;
		if (scope === "plans" && alreadyAbsent.includes("plans")) {
			notify(ctx, `Project registry already has no ${PROJECT_PLANS_DIR}/ state for ${projectKey}.`);
		} else {
			notify(ctx, `No .pi/${PROJECT_TASKS_FILE}, .pi/${PROJECT_PLANS_DIR}/, or .pi/${PROJECT_TODO_FILE} state exists to push.`);
		}
		return;
	}

	const localHashes = new Map<ProjectArtifact, string>();
	const overwriteConflicts: ProjectArtifact[] = [];
	for (const { artifact, deleteRemote } of targets) {
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		const tracked = provenance.projectResources[artifact];
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			throw new Error(`${artifact} state is tracked under another registry/branch/project key. Check Registry before pushing.`);
		}
		const remoteExists = await pathExists(remotePath);
		const remoteRevision = remoteExists
			? await projectArtifactRevision(executor, runtime, projectKey, artifact)
			: undefined;
		if (tracked && remoteRevision && remoteRevision !== tracked.revision) {
			throw new Error(`${artifact} state changed in the registry since revision ${tracked.revision.slice(0, 8)}. Pull or resolve it before pushing.`);
		}
		const localHash = await hashProjectArtifactLocal(ctx.cwd, artifact);
		if (!tracked && remoteExists && (deleteRemote || await hashProjectArtifactRemote(runtime, projectKey, artifact) !== localHash)) {
			overwriteConflicts.push(artifact);
		}
		localHashes.set(artifact, localHash);
	}

	if (overwriteConflicts.length > 0) {
		const names = overwriteConflicts.join(", ");
		if (silent) throw new Error(`Project state needs review: untracked remote state exists for ${names}. Pull or resolve it before syncing.`);
		const confirmed = await confirmOverwrite(
			ctx,
			"Project state already exists in registry",
			`Overwrite untracked remote project state for: ${names}?`,
		);
		if (!confirmed) throw new Error(`Project state push cancelled because remote state already exists for: ${names}.`);
	}

	for (const { artifact, deleteRemote } of targets) {
		const localPath = projectArtifactLocalPath(ctx.cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		if (deleteRemote) await fs.rm(remotePath, { recursive: true, force: true });
		else if (artifact === "tasks") await replaceRemoteTaskBundle(ctx.cwd, runtime, projectKey);
		else await replaceResource(localPath, remotePath);
	}
	const projectRel = `${REGISTRY_PROJECTS_DIR}/${projectKey}`;
	await runGit(executor, runtime.cacheDir, ["add", "-A", "--", projectRel]);
	const changed = (await runGit(executor, runtime.cacheDir, ["status", "--porcelain", "--", projectRel])).stdout.trim();
	if (changed) {
		await runGit(executor, runtime.cacheDir, ["commit", "-m", `Sync project state ${projectKey}`, "--", projectRel]);
		try {
			await runGit(executor, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
		} catch (error) {
			throw new Error(`Project-state commit was created in the disposable cache but push failed; local .pi state is unchanged. ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	const removedArtifacts = [...alreadyAbsent];
	for (const { artifact, deleteRemote } of targets) {
		if (deleteRemote) {
			removedArtifacts.push(artifact);
			continue;
		}
		const revision = await projectArtifactRevision(executor, runtime, projectKey, artifact);
		if (!revision) throw new Error(`Cannot determine registry revision for project ${artifact} state.`);
		await recordProjectProvenance(ctx, runtime, projectKey, artifact, revision, localHashes.get(artifact)!);
	}
	await clearProjectProvenanceEntries(ctx, removedArtifacts);
	const targetNames = targets.map(({ artifact }) => artifact);
	if (!silent) notify(ctx, `${changed ? "Pushed" : "Project registry already matches"} ${targetNames.join(" + ")} for ${projectKey}.`);
}

export async function pullProjectState(executor: RegistryExecutor, ctx: RegistryContext, scope: ProjectScope): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const projectKey = await resolveProjectKey(executor, ctx.cwd);
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
		const tracked = provenance.projectResources[artifact];
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			throw new Error(`${artifact} state is tracked under another registry/branch/project key. Check Registry before pulling.`);
		}
		const remoteRevision = await projectArtifactRevision(executor, runtime, projectKey, artifact);
		if (!remoteRevision) throw new Error(`Cannot determine registry revision for project ${artifact} state.`);
		const remoteHash = await hashProjectArtifactRemote(runtime, projectKey, artifact);
		if (await pathExists(localPath)) {
			const localHash = await hashProjectArtifactLocal(ctx.cwd, artifact);
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
		if (artifact === "tasks") await replaceLocalTaskBundle(ctx.cwd, runtime, projectKey);
		else await replaceResource(remotePath, localPath);
		const item = metadata.get(artifact)!;
		const localHash = await hashProjectArtifactLocal(ctx.cwd, artifact);
		await recordProjectProvenance(ctx, runtime, projectKey, artifact, item.remoteRevision, localHash);
	}
	notify(ctx, `Pulled ${targets.join(" + ")} for ${projectKey}. Reloading project state…`);
}
