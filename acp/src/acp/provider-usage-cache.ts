import type { Logger } from "../logging.js";
import type { DesktopModelUsageStatus } from "./desktop-commands.js";

type Model = { provider: string; id: string; name?: string | undefined };
type Result = { refresh: "ready" | "unavailable" | "failed"; status?: DesktopModelUsageStatus; credentialPending?: true; cacheInvalidated?: true; cacheScope?: string };
type Cache = {
	read(models: readonly Model[]): Promise<{ scope: string; routeScopes: Record<string, string>; snapshots: DesktopModelUsageStatus[] }>;
	query(model: Model, fetch: () => Promise<Result>): Promise<Result>;
};

/** Lazy bridge only. Root model usage owns credentials, disk storage and cache policy. */
export class ProviderUsageCacheHost {
	private cache: Promise<Cache | undefined> | undefined;
	constructor(private readonly options: { agentDir?: string; logger: Logger }) {}

	async read(models: readonly Model[]) {
		return (await this.load())?.read(models);
	}

	async query(model: Model, fetch: () => Promise<Result>): Promise<Result> {
		const cache = await this.load();
		return cache ? cache.query(model, fetch) : fetch();
	}

	private load(): Promise<Cache | undefined> {
		return this.cache ??= (async () => {
			try {
				const url = new URL("../../../dist/app/model/model-usage-cache.js", import.meta.url).href;
				const module = await import(url) as { ModelUsageCache: new (options: { agentDir?: string; log: (level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) => void }) => Cache };
				return new module.ModelUsageCache({
					...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
					log: (level, event, details) => { try { this.options.logger[level](`${event} ${JSON.stringify(details ?? {})}`); } catch { /* Diagnostic only. */ } },
				});
			} catch (error) {
				try { this.options.logger.warn(`model_usage.cache_unavailable ${error instanceof Error ? error.name : "Error"}`); } catch { /* Diagnostic only. */ }
				return undefined;
			}
		})();
	}
}
