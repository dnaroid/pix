import { join } from "node:path";
import type { DesktopRegistryActionRequest, DesktopRegistryDiffRequest } from "../acp/desktop-commands.js";
import { loadRegistryConfig } from "./config-reader.js";
import { loadRuntimeConfig, saveProjectKeyConfig, saveRegistryConfig } from "./config.js";
import { withRegistryCache } from "./cache-lock.js";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { collectRegistryDiff } from "./diff-service.js";
import { registryExecutor } from "./executor.js";
import { ensureRegistryCache, resourceRevision } from "./git.js";
import { editResourceTags } from "./metadata.js";
import { SKILL_FILE, type RegistryUiSnapshot } from "./model.js";
import { pathExists, projectResourcePath, registryResourcePath, validateName } from "./paths.js";
import { keepProjectKey, migrateProjectKey } from "./project-key-migration.js";
import { pullProjectState, pushProjectState } from "./projects.js";
import { installResource, makeResourceLocal, pushResource, removeResource, uninstallResource, updateResource } from "./resources.js";
import { collectRegistryUiSnapshot } from "./status.js";
import { publishResourceTags } from "./tag-publication.js";
import { selectPublicationRuntime } from "./publication-location.js";
import { togglePublicationScope } from "./publication-scope.js";
import { pushProjectResourceChanges, syncInstalledResources, syncProjectResources } from "./project-resource-sync.js";
import { setAgentModelOverride } from "./agent-models.js";
import { confirmRegistryResource, type ConfirmedResourceRequest } from "./confirmed-resource.js";
import { markResourceMerged, mergeResource, previewResourceMerge } from "./resource-merge.js";
import { compareProjectArtifact, markProjectArtifactMerged, mergeProjectArtifact, previewProjectMerge } from "./project-merge.js";
import type { RegistryDiffPayload } from "./diff.js";

/** Read-only diff requests have no dialogs; merge previews only need the project cwd. */
function headlessContext(cwd: string): RegistryContext {
	return {
		cwd,
		hasUI: false,
		ui: {
			confirm: async () => false,
			input: async () => undefined,
			editor: async () => undefined,
			notify: () => undefined,
		},
	};
}

async function registryDiffPayload(executor: RegistryExecutor, request: DesktopRegistryDiffRequest): Promise<RegistryDiffPayload> {
	const ctx = headlessContext(request.cwd);
	if (request.type === "project") {
		const files = request.mode === "merge"
			? await previewProjectMerge(executor, ctx, request.artifact)
			: await compareProjectArtifact(executor, ctx, request.artifact);
		return { version: 1, type: "project", name: request.artifact, files };
	}
	if (request.mode === "merge") {
		return { version: 1, type: request.type, name: request.name, files: await previewResourceMerge(executor, ctx, request.type, request.name) };
	}
	return collectRegistryDiff(executor, request.cwd, request.type, request.name);
}

async function configure(ctx: RegistryContext): Promise<void> {
	const current = loadRegistryConfig(ctx.cwd);
	const remote = await ctx.ui.input("Registry Git remote", current.remote ?? "");
	if (remote === undefined) return;
	const branch = await ctx.ui.input("Registry branch", current.branch);
	if (branch === undefined) return;
	await saveRegistryConfig(remote, branch.trim() || "main");
}

async function projectKey(ctx: RegistryContext): Promise<void> {
	// Do not offer an automatically generated key as a manual override: saving it
	// explicitly would prevent a later Git origin from taking precedence.
	const current = loadRegistryConfig(ctx.cwd).projectKey;
	const key = await ctx.ui.input("Project registry key (empty uses Git origin or automatic key)", current ?? "");
	if (key !== undefined) await saveProjectKeyConfig(ctx.cwd, key.trim() || undefined);
}

/** No new publication: remember the published revision BEFORE opening the editor. */
async function tags(request: Extract<DesktopRegistryActionRequest, { type: unknown }>, ctx: RegistryContext, executor: RegistryExecutor, signal: AbortSignal): Promise<void> {
	validateName(request.name);
	let publicationError: unknown;
	const published = await withRegistryCache(async () => {
		if (!loadRegistryConfig(ctx.cwd).remote) return undefined;
		let runtime = loadRuntimeConfig(ctx.cwd);
		await ensureRegistryCache(executor, runtime);
		runtime = await selectPublicationRuntime(executor, ctx, runtime, request.type, request.name);
		if (!await pathExists(registryResourcePath(runtime.cacheDir, request.type, request.name, runtime))) return undefined;
		return { runtime, revision: await resourceRevision(executor, runtime, request.type, request.name) };
	}, signal).catch((cause: unknown) => { publicationError = cause; return undefined; });
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
	}, signal);
}

export class DesktopRegistryService {
	/** Aborted on ACP shutdown: stops lock waits and kills registry Git children. */
	private readonly shutdown = new AbortController();
	private readonly inFlight = new Set<Promise<unknown>>();

	constructor(private readonly baseExecutor: RegistryExecutor = registryExecutor) {}

	/**
	 * Abort and settle every operation so the cross-process checkout lock is
	 * released before the process exits. A process killed while holding it would
	 * block every other ACP until the lock goes stale.
	 */
	async dispose(): Promise<void> {
		this.shutdown.abort(new Error("Registry service is shutting down."));
		await Promise.allSettled([...this.inFlight]);
	}

	/**
	 * Runs one operation under a signal combining shutdown and the caller's
	 * request cancellation: lock waits stop and Registry Git children are killed.
	 */
	private track<T>(request: AbortSignal | undefined, operation: (signal: AbortSignal, executor: RegistryExecutor) => Promise<T>): Promise<T> {
		const signal = request ? AbortSignal.any([this.shutdown.signal, request]) : this.shutdown.signal;
		if (signal.aborted) return Promise.reject(signal.reason);
		const base = this.baseExecutor;
		const executor: RegistryExecutor = {
			exec(command, args, options) {
				signal.throwIfAborted();
				return base.exec(command, args, { ...options, signal });
			},
		};
		const promise = operation(signal, executor);
		this.inFlight.add(promise);
		void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
		return promise;
	}

	action(request: DesktopRegistryActionRequest, ctx: RegistryContext, signal?: AbortSignal): Promise<RegistryUiSnapshot> {
		return this.track(signal, (operationSignal, executor) => this.runAction(request, ctx, operationSignal, executor));
	}

	confirmedResource(request: ConfirmedResourceRequest, ctx: RegistryContext, signal: AbortSignal, beforeCommit: () => Promise<void>, exclusive: <T>(operation: () => Promise<T>) => Promise<T>) {
		return this.track(signal, (operationSignal, executor) => confirmRegistryResource(executor, ctx, request, operationSignal, beforeCommit, exclusive));
	}

	diff(request: DesktopRegistryDiffRequest, signal?: AbortSignal) {
		return this.track(signal, (operationSignal, executor) => withRegistryCache(
			() => registryDiffPayload(executor, request), operationSignal));
	}

	private async runAction(
		request: DesktopRegistryActionRequest,
		ctx: RegistryContext,
		signal: AbortSignal,
		executor: RegistryExecutor,
	): Promise<RegistryUiSnapshot> {
		let error: string | undefined;
		// Editors/dialogs must not hold the checkout lock or block background refreshes.
		try {
			if (request.action === "configure") await configure(ctx);
			else if (request.action === "project-key") await projectKey(ctx);
			else if (request.action === "tags") await tags(request, ctx, executor, signal);
		} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		return withRegistryCache(async () => {
			try {
				switch (request.action) {
					case "set-agent-model": await setAgentModelOverride(ctx.cwd, request.name, request.model); break;
					case "reset-agent-model": await setAgentModelOverride(ctx.cwd, request.name); break;
					case "keep-project-key": await keepProjectKey(ctx); break;
					case "migrate-project-key": await migrateProjectKey(executor, ctx); break;
					case "push-project-resources": await pushProjectResourceChanges(executor, ctx); break;
					case "pull-resources": await syncInstalledResources(executor, ctx, "pull"); break;
					case "push-resources": await syncInstalledResources(executor, ctx, "push"); break;
					case "install": await installResource(executor, ctx, request.type, request.name); break;
					case "install-global": await installResource(executor, ctx, request.type, request.name, signal); break;
					case "update": await updateResource(executor, ctx, request.type, request.name); break;
					case "push": await pushResource(executor, ctx, request.type, request.name); break;
					case "uninstall": await uninstallResource(ctx, request.type, request.name); break;
					case "remove": await removeResource(executor, ctx, request.type, request.name); break;
					case "make-local": await makeResourceLocal(executor, ctx, request.type, request.name); break;
					case "toggle-scope": await togglePublicationScope(executor, ctx, request.type, request.name); break;
					case "merge": await mergeResource(executor, ctx, request.type, request.name, { writeConflictMarkers: request.writeConflictMarkers === true }); break;
					case "mark-merged": await markResourceMerged(executor, ctx, request.type, request.name); break;
					case "merge-project": await mergeProjectArtifact(executor, ctx, request.scope, { writeConflictMarkers: request.writeConflictMarkers === true }); break;
					case "mark-merged-project": await markProjectArtifactMerged(executor, ctx, request.scope); break;
					case "push-project": await pushProjectState(executor, ctx, request.scope); break;
					case "pull-project": await pullProjectState(executor, ctx, request.scope); break;
					case "sync-project":
						await syncProjectResources(executor, ctx);
						await pushProjectState(executor, ctx, request.scope, true);
						break;
				}
			} catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
			// A cancelled request gets no snapshot; rejecting releases the lock now.
			signal.throwIfAborted();
			try { return await collectRegistryUiSnapshot(executor, ctx.cwd, error); }
			catch (cause) {
				// Cancellation/shutdown rejects instead of returning a fallback snapshot.
				signal.throwIfAborted();
				const config = loadRegistryConfig(ctx.cwd);
				return {
					version: 1, configured: Boolean(config.remote), branch: config.branch,
					...(config.remote ? { remote: config.remote } : {}), items: [], checkedAt: new Date().toISOString(),
					error: error ?? (cause instanceof Error ? cause.message : String(cause)),
				};
			}
		}, signal);
	}
}
