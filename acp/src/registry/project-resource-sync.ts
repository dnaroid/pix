import type { RegistryContext, RegistryExecutor } from "./context.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, resolveProjectKey } from "./git.js";
import { assertPublicationDirectories } from "./publication-location.js";
import { pushResourceWithRuntime, updateResourceWithRuntime } from "./resources.js";
import { collectStatuses } from "./status.js";

/** Explicit catalog batch. The caller holds the checkout lock for the entire batch. */
export async function syncInstalledResources(executor: RegistryExecutor, ctx: RegistryContext, direction: "pull" | "push"): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const statuses = await collectStatuses(executor, ctx.cwd, runtime);
	const desired = direction === "pull" ? "update-available" : "local-changes";
	const silent: RegistryContext = { ...ctx, hasUI: false };
	const sync = direction === "pull" ? updateResourceWithRuntime : pushResourceWithRuntime;
	// Use only fresh, installed publications. A failure keeps earlier successes
	// and leaves remaining items for a retry; never prompt to overwrite.
	for (const { type, name, kind, local, remote } of statuses) {
		if (kind !== desired || !local || !remote) continue;
		const scoped = {
			...runtime,
			publicationScope: remote.publicationScope ?? "global" as const,
			...(remote.projectKey ? { projectKey: remote.projectKey } : {}),
		};
		await sync(executor, silent, scoped, type, name);
	}
}

/** Explicit bulk push under the checkout lock; never touches Global publications. */
export async function pushProjectResourceChanges(executor: RegistryExecutor, ctx: RegistryContext): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const scoped = { ...runtime, publicationScope: "project" as const, projectKey: await resolveProjectKey(executor, ctx.cwd) };
	await assertPublicationDirectories(scoped);
	const statuses = await collectStatuses(executor, ctx.cwd, scoped);
	const targets = statuses.filter((status) => status.local
		&& status.kind === "local-changes" && status.remote?.publicationScope === "project");
	// Existing revision/provenance guards remain authoritative; no overwrite dialogs.
	// Stop on failure, retaining successful earlier pushes for a safe retry.
	const silent: RegistryContext = { ...ctx, hasUI: false };
	for (const { type, name } of targets) await pushResourceWithRuntime(executor, silent, scoped, type, name);
}

/** Called under the service checkout lock. Never promotes resources to Global. */
export async function syncProjectResources(executor: RegistryExecutor, ctx: RegistryContext): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const statuses = await collectStatuses(executor, ctx.cwd, runtime);
	const targets = statuses.filter((status) => status.local && status.kind === "local-only");
	if (targets.length === 0) return;
	const scoped = { ...runtime, publicationScope: "project" as const, projectKey: await resolveProjectKey(executor, ctx.cwd) };
	await assertPublicationDirectories(scoped);
	// Background work must never open an overwrite dialog. Existing push guards
	// recheck the remote revision; untracked remote collisions are not targets.
	const silent: RegistryContext = { ...ctx, hasUI: false };
	for (const { type, name } of targets) await pushResourceWithRuntime(executor, silent, scoped, type, name);
}
