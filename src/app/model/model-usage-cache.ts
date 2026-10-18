import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { readUsageCache, writeUsageCache } from "../usage-cache-file.js";
import { modelUsageAuthPath, withModelUsageAuthScope } from "./model-usage-auth-scope.js";
import { markModelUsageStale, modelUsageCacheIdentity, modelUsageDescriptor, type ModelUsageDescriptor, type ModelUsageLimitWindow, type ModelUsageStatus } from "./model-usage-status.js";

type Model = { provider: string; id: string; name?: string | undefined };
type Log = (level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) => void;
export type CachedModelUsage = { scope: string; routeScopes: Record<string, string>; snapshots: ModelUsageStatus[] };
export type CacheableUsageResult = { refresh: "ready" | "unavailable" | "failed"; status?: ModelUsageStatus; credentialPending?: true; cacheInvalidated?: true; cacheScope?: string };
type SavedQuota = { scope: string; quota: ModelUsageStatus };
const MAX_BYTES = 64 * 1024;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function isWindow(value: unknown): value is ModelUsageLimitWindow {
	return record(value) && finite(value.remainingPercent) && value.remainingPercent >= 0 && value.remainingPercent <= 100
		&& finite(value.resetAt) && finite(value.windowSeconds) && value.windowSeconds >= 0
		&& (value.hasKnownWindowDuration === undefined || typeof value.hasKnownWindowDuration === "boolean")
		&& (value.resetAtEstimated === undefined || typeof value.resetAtEstimated === "boolean")
		&& (value.label === undefined || (typeof value.label === "string" && value.label.trim().length > 0));
}

function isQuota(value: unknown): value is ModelUsageStatus {
	return record(value) && typeof value.modelKey === "string" && typeof value.provider === "string" && ["openai", "anthropic", "zhipu", "google-antigravity"].includes(value.provider)
		&& finite(value.updatedAt) && value.updatedAt >= 0 && (value.accountEmail === undefined || typeof value.accountEmail === "string")
		&& (value.hourly === undefined || isWindow(value.hourly)) && (value.weekly === undefined || isWindow(value.weekly));
}

function isSavedQuota(value: unknown): value is SavedQuota {
	return record(value) && typeof value.scope === "string" && /^[a-f0-9]{64}$/u.test(value.scope) && isQuota(value.quota);
}

/** Whitelist quota display data: never persist credentials, headers, credits or arbitrary response fields. */
function quotaSnapshot(status: ModelUsageStatus): ModelUsageStatus {
	return {
		modelKey: status.modelKey, provider: status.provider, updatedAt: status.updatedAt,
		...(status.accountEmail === undefined ? {} : { accountEmail: status.accountEmail }),
		...(status.hourly ? { hourly: windowSnapshot(status.hourly) } : {}),
		...(status.weekly ? { weekly: windowSnapshot(status.weekly) } : {}),
	};
}

function windowSnapshot(window: ModelUsageLimitWindow): ModelUsageLimitWindow {
	return {
		remainingPercent: window.remainingPercent, resetAt: window.resetAt, windowSeconds: window.windowSeconds,
		...(window.hasKnownWindowDuration === undefined ? {} : { hasKnownWindowDuration: window.hasKnownWindowDuration }),
		...(window.resetAtEstimated === undefined ? {} : { resetAtEstimated: window.resetAtEstimated }),
		...(window.label === undefined ? {} : { label: window.label }),
	};
}

/** Profile-owned quota cache. Every read and fetch is checked against local credential identity. */
export class ModelUsageCache {
	private readonly reported = new Set<string>();
	constructor(private readonly options: {
		agentDir?: string;
		log?: Log;
		identity?: (descriptor: ModelUsageDescriptor) => Promise<string | undefined>;
	} = {}) {}

	read(models: readonly Model[]): Promise<CachedModelUsage> {
		return withModelUsageAuthScope(this.options.agentDir, async () => {
			const descriptors = [...new Map(models.flatMap((model) => {
				const descriptor = modelUsageDescriptor(model);
				return descriptor ? [[descriptor.modelKey, descriptor] as const] : [];
			})).values()];
			const identities = await this.identities(descriptors);
			const snapshots: ModelUsageStatus[] = [];
			const queue = [...descriptors];
			await Promise.all(Array.from({ length: Math.min(8, queue.length) }, async () => {
				for (let descriptor = queue.shift(); descriptor; descriptor = queue.shift()) {
					const identity = identities.get(descriptor.modelKey);
					if (!identity) continue;
					const snapshot = await this.readOne(descriptor, identity);
					if (snapshot) snapshots.push(snapshot);
				}
			}));
			const latest = await this.identities(descriptors);
			const scope = this.scope(latest);
			return { scope, routeScopes: this.routeScopes(latest), snapshots: scope === this.scope(identities) ? snapshots : [] };
		});
	}

	query(model: Model, fetch: () => Promise<CacheableUsageResult>): Promise<CacheableUsageResult> {
		return withModelUsageAuthScope(this.options.agentDir, async (): Promise<CacheableUsageResult> => {
			const descriptor = modelUsageDescriptor(model);
			if (!descriptor) return fetch();
			const identity = await this.identity(descriptor);
			const cacheScope = this.routeScope(descriptor.modelKey, identity);
			const result = await fetch();
			if (identity !== await this.identity(descriptor)) return { refresh: "unavailable", cacheInvalidated: true };
			if (identity && result.refresh === "ready" && result.status && !result.status.stale
				&& result.status.modelKey === descriptor.modelKey && isQuota(result.status)) {
				try { await writeUsageCache(this.path(descriptor), { scope: cacheScope, quota: quotaSnapshot(result.status) }, MAX_BYTES); }
				catch (error) { this.report("write", error); }
			}
			if (identity !== await this.identity(descriptor)) return { refresh: "unavailable", cacheInvalidated: true };
			return { ...result, cacheScope };
		});
	}

	private async readOne(descriptor: ModelUsageDescriptor, identity: string): Promise<ModelUsageStatus | undefined> {
		try {
			const saved = await readUsageCache(this.path(descriptor), isSavedQuota, MAX_BYTES);
			const provider = descriptor.kind === "claude-code" ? "anthropic" : descriptor.kind;
			if (!saved || saved.scope !== this.routeScope(descriptor.modelKey, identity)
				|| saved.quota.modelKey !== descriptor.modelKey || saved.quota.provider !== provider) return undefined;
			return markModelUsageStale(quotaSnapshot(saved.quota));
		} catch (error) { this.report("read", error); return undefined; }
	}

	private async identities(descriptors: readonly ModelUsageDescriptor[]): Promise<Map<string, string | undefined>> {
		const routes = new Map<string, Promise<string | undefined>>();
		return new Map(await Promise.all(descriptors.map(async (descriptor) => {
			const route = `${descriptor.kind}:${descriptor.modelKey.split("/")[0]}`;
			let identity = routes.get(route);
			if (!identity) { identity = this.identity(descriptor); routes.set(route, identity); }
			return [descriptor.modelKey, await identity] as const;
		})));
	}

	private async identity(descriptor: ModelUsageDescriptor): Promise<string | undefined> {
		try { return await (this.options.identity ?? modelUsageCacheIdentity)(descriptor); }
		catch (error) { this.report("identity", error); return undefined; }
	}

	private scope(identities: ReadonlyMap<string, string | undefined>): string {
		return hash(["pix-usage-scope-v1", Object.entries(this.routeScopes(identities)).sort(([a], [b]) => a.localeCompare(b))]);
	}

	private routeScopes(identities: ReadonlyMap<string, string | undefined>): Record<string, string> {
		return Object.fromEntries([...identities].map(([modelKey, identity]) => [modelKey.split("/")[0]!, this.routeScope(modelKey, identity)]));
	}

	private routeScope(modelKey: string, identity: string | undefined): string {
		return hash(["pix-usage-route-v1", modelUsageAuthPath(), modelKey.split("/")[0], identity ?? null]);
	}

	private path(descriptor: ModelUsageDescriptor): string {
		// One last-success slot per model: token rotations cannot leave unbounded old-account files.
		return join(dirname(modelUsageAuthPath()), "cache", "usage", "v1", "quotas", `${hash(descriptor.modelKey)}.json`);
	}

	private report(operation: string, error: unknown): void {
		if (this.reported.has(operation)) return;
		this.reported.add(operation);
		try { this.options.log?.("warn", `model_usage.cache_${operation}_failed`, { error: error instanceof Error ? error.name : "Error" }); } catch { /* Diagnostic only. */ }
	}
}
