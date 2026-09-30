import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { confirmOverwrite } from "./context.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, resourceRevision, runGit } from "./git.js";
import type { RegistryRuntime, ResourceType } from "./model.js";
import { pathExists, registryResourcePath, registryResourceRelativePath, resourceKey, validateName } from "./paths.js";
import { assertOtherProjectsAbsent, samePublication, selectPublicationRuntime } from "./publication-location.js";
import { readProvenance, recordProvenance } from "./provenance.js";
import { agentCompanion, agentCompanionStat, hashResource } from "./resource-files.js";

async function assertDestinationAbsent(runtime: RegistryRuntime, type: ResourceType, name: string): Promise<void> {
	const path = registryResourcePath(runtime.cacheDir, type, name, runtime);
	if (await pathExists(path) || (type === "agent" && await pathExists(agentCompanion(path)))) {
		throw new Error(`Publication name collision: ${type} "${name}" already exists in the destination scope. Neither copy was overwritten.`);
	}
}

/** Move published bytes only, never publish the working project's local edits. */
export async function togglePublicationScope(executor: RegistryExecutor, ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	validateName(name);
	let sourceRuntime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, sourceRuntime);
	sourceRuntime = await selectPublicationRuntime(executor, ctx, sourceRuntime, type, name);
	const source = registryResourcePath(sourceRuntime.cacheDir, type, name, sourceRuntime);
	if (!await pathExists(source)) throw new Error(`${type} "${name}" is not published.`);
	if (!sourceRuntime.projectKey) throw new Error("Set a project key before switching publication to Project scope.");
	const destinationRuntime: RegistryRuntime = { ...sourceRuntime, publicationScope: sourceRuntime.publicationScope === "project" ? "global" : "project" };
	await assertDestinationAbsent(destinationRuntime, type, name);
	// A new global definition must not shadow a same-named publication in ANY project.
	if (destinationRuntime.publicationScope === "global") {
		await assertOtherProjectsAbsent(destinationRuntime, type, name);
	}
	const destination = registryResourcePath(sourceRuntime.cacheDir, type, name, destinationRuntime);
	await hashResource(type, source); // Reject symlinked definitions/assets/companions before moving.
	const sourceRevision = await resourceRevision(executor, sourceRuntime, type, name);
	const companion = type === "agent" && await agentCompanionStat(source);
	if (!await confirmOverwrite(ctx, "Change publication scope", `Move ${type} "${name}" to ${destinationRuntime.publicationScope === "project" ? `Project (${sourceRuntime.projectKey})` : "Global"} scope? Local copies and local edits stay unchanged.`)) return;
	await fs.mkdir(dirname(destination), { recursive: true });
	await fs.rename(source, destination);
	if (companion) await fs.rename(agentCompanion(source), agentCompanion(destination));
	const sourceRelative = registryResourceRelativePath(type, name, sourceRuntime);
	const destinationRelative = registryResourceRelativePath(type, name, destinationRuntime);
	const paths = [sourceRelative, destinationRelative, ...(companion ? [sourceRelative.slice(0, -3), destinationRelative.slice(0, -3)] : [])];
	await runGit(executor, sourceRuntime.cacheDir, ["add", "-A", "--", ...paths]);
	await runGit(executor, sourceRuntime.cacheDir, ["commit", "-m", `Move ${type} ${name} to ${destinationRuntime.publicationScope} scope`, "--", ...paths]);
	await runGit(executor, sourceRuntime.cacheDir, ["push", "-u", "origin", sourceRuntime.branch], { timeout: 180_000 });
	const tracked = (await readProvenance(ctx)).resources[resourceKey(type, name)];
	if (tracked && samePublication(tracked, sourceRuntime)) {
		const revision = await resourceRevision(executor, destinationRuntime, type, name);
		if (!revision) throw new Error("Moved publication has no remote revision.");
		// Moving bytes is not a sync: preserve the local baseline and any pending remote update.
		await recordProvenance(ctx, destinationRuntime, type, name,
			tracked.revision === sourceRevision ? revision : tracked.revision, tracked.hash);
	}
	ctx.ui.notify(`${type} ${name} is now ${destinationRuntime.publicationScope === "project" ? "Project" : "Global"}.`, "info");
}
