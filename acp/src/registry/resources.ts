import { RegistryContext, RegistryExecutor, confirmOverwrite, notify } from "./context.js";
import { RegistryRuntime, ResourceType, SKILL_FILE } from "./model.js";
import { pathExists, projectResourcePath, registryResourcePath, registryResourceRelativePath, resourceKey, validateName } from "./paths.js";
import { join, relative } from "node:path";
import { agentCompanion, agentGitPaths, assertValidAgentDefinition, hashResource, replaceAgent, replaceResource } from "./resource-files.js";
import { ensureRegistryCache, resourceRevision, runGit } from "./git.js";
import { clearResourceProvenance, readProvenance, recordProvenance } from "./provenance.js";
import { loadRuntimeConfig } from "./config.js";
import { promises as fs } from "node:fs";
import { assertOtherProjectsAbsent, samePublication, selectPublicationRuntime } from "./publication-location.js";

export async function installResourceWithRuntime(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<void> {
	validateName(name);
	const source = registryResourcePath(runtime.cacheDir, type, name, runtime);
	if (!(await pathExists(source))) throw new Error(`${type} "${name}" does not exist in the registry.`);
	if (type === "skill" && !(await pathExists(join(source, SKILL_FILE)))) throw new Error(`Registry skill "${name}" is missing ${SKILL_FILE}.`);
	if (type === "agent") await assertValidAgentDefinition(source, name);
	const destination = projectResourcePath(ctx, type, name);
	if (await pathExists(destination)) {
		const confirmed = await confirmOverwrite(ctx, "Resource already exists", `Overwrite project ${type} "${name}" from the registry?`);
		if (!confirmed) throw new Error(`Project ${type} "${name}" already exists; install cancelled.`);
	}
	if (type === "agent") await replaceAgent(source, destination);
	else await replaceResource(source, destination);
	const revision = await resourceRevision(executor, runtime, type, name);
	if (!revision) throw new Error(`Cannot determine registry revision for ${type} "${name}".`);
	await recordProvenance(ctx, runtime, type, name, revision, await hashResource(type, destination));
}

export async function installResource(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name);
	await installResourceWithRuntime(executor, ctx, runtime, type, name);
	const destination = projectResourcePath(ctx, type, name);
	notify(ctx, `Installed ${type} "${name}" → ${relative(ctx.cwd, destination)}.`);
}

export async function updateResourceWithRuntime(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<"updated" | "current"> {
	validateName(name);
	const provenance = await readProvenance(ctx);
	const tracked = provenance.resources[resourceKey(type, name)];
	if (!tracked) throw new Error(`${type} "${name}" is not tracked by the registry. Install it first.`);
	if (!samePublication(tracked, runtime)) {
		throw new Error(`${type} "${name}" was installed from ${tracked.remote} (${tracked.branch}); current registry is ${runtime.remote} (${runtime.branch}).`);
	}
	const source = registryResourcePath(runtime.cacheDir, type, name, runtime);
	if (!(await pathExists(source))) throw new Error(`${type} "${name}" was removed from the registry.`);
	const remoteRevision = await resourceRevision(executor, runtime, type, name);
	if (!remoteRevision) throw new Error(`Cannot determine registry revision for ${type} "${name}".`);
	const destination = projectResourcePath(ctx, type, name);
	if (await pathExists(destination)) {
		const localHash = await hashResource(type, destination);
		if (localHash !== tracked.hash) {
			throw new Error(`${type} "${name}" has local changes. Push them or resolve the divergence before updating.`);
		}
	}
	if (remoteRevision === tracked.revision && await pathExists(destination)) return "current";
	if (type === "agent") await replaceAgent(source, destination);
	else await replaceResource(source, destination);
	await recordProvenance(ctx, runtime, type, name, remoteRevision, await hashResource(type, destination));
	return "updated";
}

export async function updateResource(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<"updated" | "current"> {
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name);
	return updateResourceWithRuntime(executor, ctx, runtime, type, name);
}

export async function pushResourceWithRuntime(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
): Promise<{ changed: boolean; revision?: string | undefined }> {
	validateName(name);
	const source = projectResourcePath(ctx, type, name);
	if (!(await pathExists(source))) throw new Error(`Project ${type} "${name}" does not exist.`);
	if (type === "skill" && !(await pathExists(join(source, SKILL_FILE)))) throw new Error(`Project skill "${name}" is missing ${SKILL_FILE}.`);
	if (type === "agent") await assertValidAgentDefinition(source, name);
	const destination = registryResourcePath(runtime.cacheDir, type, name, runtime);
	const provenance = await readProvenance(ctx);
	const tracked = provenance.resources[resourceKey(type, name)];
	const remoteExists = await pathExists(destination);
	if (!remoteExists && runtime.publicationScope !== "project") await assertOtherProjectsAbsent(runtime, type, name);
	const remoteRevision = remoteExists ? await resourceRevision(executor, runtime, type, name) : undefined;

	if (tracked && samePublication(tracked, runtime) && remoteRevision && remoteRevision !== tracked.revision) {
		throw new Error(`${type} "${name}" changed in the registry since revision ${tracked.revision.slice(0, 8)}. Check Registry and update/resolve before pushing.`);
	}

	const localHash = await hashResource(type, source);
	if ((!tracked || !samePublication(tracked, runtime)) && remoteExists) {
		const remoteHash = await hashResource(type, destination);
		if (remoteHash !== localHash) {
			const confirmed = await confirmOverwrite(ctx, "Registry resource already exists", `Overwrite registry ${type} "${name}" with this project's untracked copy?`);
			if (!confirmed) throw new Error(`Registry ${type} "${name}" already exists; push cancelled.`);
		}
	}

	if (type === "agent") await replaceAgent(source, destination);
	else await replaceResource(source, destination);
	const rel = registryResourceRelativePath(type, name, runtime);
	const paths = type === "agent" ? await agentGitPaths(executor, runtime, name) : [rel];
	await runGit(executor, runtime.cacheDir, ["add", "-A", "--", ...paths]);
	const changed = (await runGit(executor, runtime.cacheDir, ["status", "--porcelain", "--", ...paths])).stdout.trim();
	if (!changed) {
		const revision = remoteRevision ?? await resourceRevision(executor, runtime, type, name);
		if (revision) await recordProvenance(ctx, runtime, type, name, revision, localHash);
		return { changed: false, revision };
	}

	const verb = remoteExists ? "Update" : "Add";
	await runGit(executor, runtime.cacheDir, ["commit", "-m", `${verb} ${type} ${name}`, "--", ...paths]);
	try {
		await runGit(executor, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Registry commit was created in the disposable cache but push failed; the project copy is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}
	const revision = (await runGit(executor, runtime.cacheDir, ["rev-parse", "HEAD"])).stdout.trim();
	await recordProvenance(ctx, runtime, type, name, revision, localHash);
	return { changed: true, revision };
}

export async function pushResource(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name, "project");
	const result = await pushResourceWithRuntime(executor, ctx, runtime, type, name);
	if (!result.changed) {
		notify(ctx, `${type} "${name}" already matches the registry.`);
		return;
	}
	const revision = result.revision;
	if (!revision) throw new Error(`Cannot determine pushed registry revision for ${type} "${name}".`);
	notify(ctx, `Pushed ${type} "${name}" to ${runtime.remote} (${runtime.branch}) at ${revision.slice(0, 8)}.`);
}

export async function removeResourceWithRuntime(
	executor: RegistryExecutor,
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
	options: { confirm?: boolean } = {},
): Promise<string> {
	validateName(name);
	const target = registryResourcePath(runtime.cacheDir, type, name, runtime);
	if (!(await pathExists(target))) throw new Error(`Registry ${type} "${name}" does not exist.`);
	if (options.confirm !== false && ctx.hasUI) {
		const confirmed = await confirmOverwrite(
			ctx,
			"Remove registry resource",
			`Remove ${type} "${name}" from the registry? The project copy, if any, will be kept.`,
		);
		if (!confirmed) throw new Error(`Registry ${type} "${name}" removal cancelled.`);
	}

	const rel = registryResourceRelativePath(type, name, runtime);
	const paths = type === "agent" ? await agentGitPaths(executor, runtime, name) : [rel];
	await fs.rm(target, { recursive: type === "skill", force: false });
	if (type === "agent") await fs.rm(agentCompanion(target), { recursive: true, force: true });
	await runGit(executor, runtime.cacheDir, ["add", "-A", "--", ...paths]);
	const changed = (await runGit(executor, runtime.cacheDir, ["status", "--porcelain", "--", ...paths])).stdout.trim();
	if (!changed) throw new Error(`Registry ${type} "${name}" could not be staged for removal.`);
	await runGit(executor, runtime.cacheDir, ["commit", "-m", `Remove ${type} ${name}`, "--", ...paths]);
	try {
		await runGit(executor, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Registry removal commit was created in the disposable cache but push failed; the remote registry is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}
	return (await runGit(executor, runtime.cacheDir, ["rev-parse", "HEAD"])).stdout.trim();
}

export async function removeResource(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name);
	const revision = await removeResourceWithRuntime(executor, ctx, runtime, type, name);
	notify(ctx, `Removed ${type} "${name}" from ${runtime.remote} (${runtime.branch}) at ${revision.slice(0, 8)}. Project copies were kept.`);
}

export async function makeResourceLocal(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	validateName(name);
	let runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	runtime = await selectPublicationRuntime(executor, ctx, runtime, type, name);
	if (!(await pathExists(registryResourcePath(runtime.cacheDir, type, name, runtime)))) throw new Error(`${type} "${name}" is not published.`);
	const confirmed = await confirmOverwrite(ctx, "Make resource local", `Unpublish ${type} "${name}" from the shared Git registry? A copy will be kept in this project. Other project copies are unchanged.`);
	if (!confirmed) throw new Error("Make local cancelled.");
	// Never remove the last copy: install first if this project has none.
	const local = projectResourcePath(ctx, type, name);
	if (!(await pathExists(local))) await installResourceWithRuntime(executor, ctx, runtime, type, name);
	// An existing broken copy must not cause the usable registry copy to be lost.
	// Refuse rather than repairing it implicitly and overwriting local work.
	if (type === "skill" && !(await pathExists(join(local, SKILL_FILE)))) {
		throw new Error(`Project skill "${name}" is missing ${SKILL_FILE}; publication was kept. Repair the local copy before making it local.`);
	}
	if (type === "agent") await assertValidAgentDefinition(local, name);
	const revision = await removeResourceWithRuntime(executor, ctx, runtime, type, name, { confirm: false });
	// Retain an explicit removal marker so background sync cannot republish it.
	await recordProvenance(ctx, runtime, type, name, revision, await hashResource(type, local));
	notify(ctx, `Made ${type} "${name}" local. Project copies were kept.`);
}

export async function uninstallResource(
	ctx: RegistryContext,
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
	if (type === "agent") await fs.rm(agentCompanion(target), { recursive: true, force: true });
	await clearResourceProvenance(ctx, type, name);
	notify(ctx, `Uninstalled local ${type} "${name}". Registry copy was kept.`);
}
