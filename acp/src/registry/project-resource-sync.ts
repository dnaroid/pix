import type { RegistryContext, RegistryExecutor } from "./context.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, resolveProjectKey } from "./git.js";
import { assertPublicationDirectories } from "./publication-location.js";
import { pushResourceWithRuntime } from "./resources.js";
import { collectStatuses } from "./status.js";

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
