import { join } from "node:path";
import type { DesktopRegistryActionRequest, DesktopRegistryDiffRequest } from "../acp/desktop-commands.js";
import { loadRegistryConfig } from "./config-reader.js";
import { loadRuntimeConfig, registryUiCacheRoot, saveProjectKeyConfig, saveRegistryConfig } from "./config.js";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { collectRegistryDiff } from "./diff-service.js";
import { registryExecutor } from "./executor.js";
import { ensureRegistryCache, resolveProjectKey, resourceRevision } from "./git.js";
import { editResourceTags } from "./metadata.js";
import { SKILL_FILE, type RegistryUiSnapshot } from "./model.js";
import { pathExists, projectResourcePath, registryResourcePath, validateName } from "./paths.js";
import { pullProjectState, pushProjectState } from "./projects.js";
import { installResource, makeResourceLocal, pushResource, removeResource, uninstallResource, updateResource } from "./resources.js";
import { collectRegistryUiSnapshot } from "./status.js";
import { publishResourceTags } from "./tag-publication.js";
import { selectPublicationRuntime } from "./publication-location.js";
import { togglePublicationScope } from "./publication-scope.js";
import { syncProjectResources } from "./project-resource-sync.js";

const queues = new Map<string, Promise<void>>();

/** Serialize the shared checkout AND provenance writes, including post-action reads. */
export async function withRegistryCache<T>(task: () => Promise<T>): Promise<T> {
	const key = registryUiCacheRoot();
	const previous = queues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const turn = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.then(() => turn);
	queues.set(key, tail);
	await previous;
	try { return await task(); }
	finally {
		release();
		if (queues.get(key) === tail) queues.delete(key);
	}
}

async function configure(ctx: RegistryContext): Promise<void> {
	const current = loadRegistryConfig(ctx.cwd);
	const remote = await ctx.ui.input("Registry Git remote", current.remote ?? "");
	if (remote === undefined) return;
	const branch = await ctx.ui.input("Registry branch", current.branch);
	if (branch === undefined) return;
	await saveRegistryConfig(remote, branch.trim() || "main");
}

async function projectKey(ctx: RegistryContext, executor: RegistryExecutor): Promise<void> {
	let current = loadRegistryConfig(ctx.cwd).projectKey;
	if (!current) {
		try { current = await resolveProjectKey(executor, ctx.cwd); } catch { /* Manual key for non-Git workspaces. */ }
	}
	const key = await ctx.ui.input("Project registry key (empty uses Git origin)", current ?? "");
	if (key !== undefined) await saveProjectKeyConfig(ctx.cwd, key.trim() || undefined);
}

/** No new publication: remember the published revision BEFORE opening the editor. */
async function tags(request: Extract<DesktopRegistryActionRequest, { type: unknown }>, ctx: RegistryContext, executor: RegistryExecutor): Promise<void> {
	validateName(request.name);
	let publicationError: unknown;
	const published = await withRegistryCache(async () => {
		if (!loadRegistryConfig(ctx.cwd).remote) return undefined;
		let runtime = loadRuntimeConfig(ctx.cwd);
		await ensureRegistryCache(executor, runtime);
		runtime = await selectPublicationRuntime(executor, ctx, runtime, request.type, request.name);
		if (!await pathExists(registryResourcePath(runtime.cacheDir, request.type, request.name, runtime))) return undefined;
		return { runtime, revision: await resourceRevision(executor, runtime, request.type, request.name) };
	}).catch((cause: unknown) => { publicationError = cause; return undefined; });
	const resource = projectResourcePath(ctx, request.type, request.name);
	const file = request.type === "skill" ? join(resource, SKILL_FILE) : resource;
	let savedTags: string[] = [];
	if (!await editResourceTags(ctx, file, `Tags for ${request.type} ${request.name}`, (tags) => { savedTags = tags; })) return;
	if (publicationError) {
		throw new Error(`Tags saved locally; could not verify publication: ${publicationError instanceof Error ? publicationError.message : String(publicationError)}`);
	}
	if (!published) return;
	await withRegistryCache(async () => {
		let runtime = loadRuntimeConfig(ctx.cwd);
		if (runtime.remote !== published.runtime.remote || runtime.branch !== published.runtime.branch) {
			throw new Error("Tags saved locally; registry configuration changed while editing. Sync explicitly.");
		}
		await ensureRegistryCache(executor, runtime);
		runtime = await selectPublicationRuntime(executor, ctx, runtime, request.type, request.name);
		if (runtime.publicationScope !== published.runtime.publicationScope || (runtime.publicationScope === "project" && runtime.projectKey !== published.runtime.projectKey)) {
			throw new Error("Tags saved locally; publication scope changed while editing. Sync explicitly.");
		}
		const revision = await resourceRevision(executor, runtime, request.type, request.name);
		if (!await pathExists(registryResourcePath(runtime.cacheDir, request.type, request.name, runtime)) || revision !== published.revision) {
			throw new Error("Tags saved locally; publication changed while editing. Resolve the conflict before syncing.");
		}
		await publishResourceTags(executor, ctx, runtime, request.type, request.name, savedTags);
	});
}

export class DesktopRegistryService {
	constructor(private readonly executor: RegistryExecutor = registryExecutor) {}

	async action(request: DesktopRegistryActionRequest, ctx: RegistryContext): Promise<RegistryUiSnapshot> {
		let error: string | undefined;
		// Editors/dialogs must not hold the checkout lock or block background refreshes.
		try {
			if (request.action === "configure") await configure(ctx);
			else if (request.action === "project-key") await projectKey(ctx, this.executor);
			else if (request.action === "tags") await tags(request, ctx, this.executor);
		} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		return withRegistryCache(async () => {
			try {
				switch (request.action) {
					case "install": await installResource(this.executor, ctx, request.type, request.name); break;
					case "update": await updateResource(this.executor, ctx, request.type, request.name); break;
					case "push": await pushResource(this.executor, ctx, request.type, request.name); break;
					case "uninstall": await uninstallResource(ctx, request.type, request.name); break;
					case "remove": await removeResource(this.executor, ctx, request.type, request.name); break;
					case "make-local": await makeResourceLocal(this.executor, ctx, request.type, request.name); break;
					case "toggle-scope": await togglePublicationScope(this.executor, ctx, request.type, request.name); break;
					case "push-project": await pushProjectState(this.executor, ctx, request.scope); break;
					case "pull-project": await pullProjectState(this.executor, ctx, request.scope); break;
					case "sync-project":
						await syncProjectResources(this.executor, ctx);
						await pushProjectState(this.executor, ctx, request.scope, true);
						break;
				}
			} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
			try { return await collectRegistryUiSnapshot(this.executor, ctx.cwd, error); }
			catch (cause) {
				const config = loadRegistryConfig(ctx.cwd);
				return {
					version: 1, configured: Boolean(config.remote), branch: config.branch,
					...(config.remote ? { remote: config.remote } : {}), items: [], checkedAt: new Date().toISOString(),
					error: error ?? (cause instanceof Error ? cause.message : String(cause)),
				};
			}
		});
	}

	async diff(request: DesktopRegistryDiffRequest) {
		return withRegistryCache(() => collectRegistryDiff(this.executor, request.cwd, request.type, request.name));
	}
}
