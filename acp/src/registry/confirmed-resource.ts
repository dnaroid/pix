import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { withRegistryCache } from "./cache-lock.js";
import { loadRuntimeConfig } from "./config.js";
import { ensureRegistryCache, resourceRevision } from "./git.js";
import type { ResourceType } from "./model.js";
import { pathExists, projectResourcePath, registryResourcePath, resourceKey, validateName } from "./paths.js";
import { samePublication, selectPublicationRuntime } from "./publication-location.js";
import { readProvenance } from "./provenance.js";
import { agentCompanion, hashResource } from "./resource-files.js";
import { installResourceWithRuntime, updateResourceWithRuntime } from "./resources.js";

export interface ConfirmedResourceRequest {
	readonly action: "install" | "update";
	readonly type: ResourceType;
	readonly name: string;
}

type Exclusive = <T>(operation: () => Promise<T>) => Promise<T>;

async function entry(path: string) {
	try { return await lstat(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function displayRemote(remote: string): string {
	try {
		const url = new URL(remote);
		url.username = url.password = url.search = url.hash = "";
		return url.toString();
	} catch { return remote.replace(/^[^/]+@(?=[^:]+:)/, ""); }
}

/** Do not hold the shared checkout lock while a human makes a decision. */
export async function confirmRegistryResource(
	executor: RegistryExecutor, ctx: RegistryContext, { action, type, name }: ConfirmedResourceRequest,
	signal: AbortSignal, beforeCommit: () => Promise<void>, exclusive: Exclusive,
) {
	validateName(name);
	const destination = projectResourcePath(ctx, type, name);
	const localHash = async () => {
		for (const dir of [join(ctx.cwd, ".pi"), dirname(destination)]) {
			const stat = await entry(dir);
			if (stat && !stat.isDirectory()) throw new Error(`Unsafe project Registry directory: ${dir}`);
		}
		if (await entry(destination)) return hashResource(type, destination);
		if (type === "agent" && await entry(agentCompanion(destination))) throw new Error("Agent companion exists without an agent definition; resolve it before syncing");
	};
	const prepare = async () => {
		const config = loadRuntimeConfig(ctx.cwd);
		await ensureRegistryCache(executor, config);
		const runtime = await selectPublicationRuntime(executor, ctx, config, type, name);
		const source = registryResourcePath(runtime.cacheDir, type, name, runtime);
		if (!await pathExists(source)) throw new Error(`Registry ${type} "${name}" was not found`);
		const revision = await resourceRevision(executor, runtime, type, name);
		if (!revision) throw new Error(`Cannot determine registry revision for ${type} "${name}"`);
		const [local, sourceHash, provenance] = await Promise.all([localHash(), hashResource(type, source), readProvenance(ctx)]);
		const tracked = provenance.resources[resourceKey(type, name)];
		if (action === "install" && local !== undefined) throw new Error(`Project ${type} "${name}" already exists; use update for a tracked resource`);
		if (action === "update" && (!tracked || !samePublication(tracked, runtime))) throw new Error(`Project ${type} "${name}" is not tracked from this publication`);
		if (action === "update" && local !== undefined && local !== tracked?.hash && local !== sourceHash) throw new Error(`Project ${type} "${name}" has local changes; resolve them before updating`);
		const proof = JSON.stringify([runtime.remote, runtime.branch, runtime.publicationScope,
			runtime.publicationScope === "project" ? runtime.projectKey : undefined, revision, sourceHash, local, tracked]);
		return { runtime, revision, local, proof };
	};
	const pending = await withRegistryCache(prepare, signal);
	signal.throwIfAborted();
	await beforeCommit();
	const scope = pending.runtime.publicationScope === "project" ? `Project (${pending.runtime.projectKey})` : "Global";
	const approved = ctx.hasUI && await ctx.ui.confirm(`${action === "install" ? "Install" : "Update"} ${type} from Registry?`,
		`${type}: ${name}\nProject: ${ctx.cwd}\nRegistry: ${displayRemote(pending.runtime.remote)} (${pending.runtime.branch})\nScope: ${scope}\nRevision: ${pending.revision}`, signal);
	if (!approved) throw new Error("Registry change was not approved");
	signal.throwIfAborted();
	return exclusive(() => withRegistryCache(async () => {
		await beforeCommit();
		const current = await prepare();
		if (pending.proof !== current.proof) throw new Error("Registry publication or project copy changed after confirmation; review and try again");
		const guard = async () => {
			if (await localHash() !== current.local) throw new Error("Project copy changed after confirmation; review and try again");
			await beforeCommit();
			signal.throwIfAborted();
		};
		if (action === "update") return updateResourceWithRuntime(executor, ctx, current.runtime, type, name, guard);
		// If a copy appears after preparation, don't open another dialog under the lock or overwrite it.
		await installResourceWithRuntime(executor, { ...ctx, hasUI: false }, current.runtime, type, name, guard);
		return "installed" as const;
	}, signal));
}
