import { RequestError } from "@agentclientprotocol/sdk";
import type { Logger } from "../logging.js";
import {
	isUsageSourceId,
	PIX_USAGE_STATS_METHOD,
	type UsageSourceId,
	type UsageSourceSnapshot,
	type UsageStatsChangedNotification,
	type UsageStatsRequest,
	type UsageStatsResponse,
} from "./usage-stats-contract.js";

const ERROR_SERVER = -32000;
const ERROR_INVALID_PARAMS = -32602;

type UsageStatsLog = (level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) => void;

/** Structural view of the root `UsageStatsService`. */
export type UsageStatsServiceLike = {
	restore(): Promise<void>;
	request(options: { sources?: readonly UsageSourceId[]; refresh?: boolean }): UsageSourceSnapshot[];
	settled(): Promise<void>;
	dispose(): void;
};

/** Structural view of root `dist/app/usage-stats/index.js`. */
export type UsageStatsModule = {
	UsageStatsService: new (options: { sources: readonly unknown[]; onChange?: (source: UsageSourceId) => void; log?: UsageStatsLog }) => UsageStatsServiceLike;
	createUsageStatsSources(options: { log?: UsageStatsLog; agentDir?: string }): unknown[];
};

export type UsageStatsNotifier = (notification: UsageStatsChangedNotification) => Promise<void>;

export async function loadUsageStatsModule(): Promise<UsageStatsModule> {
	const url = new URL("../../../dist/app/usage-stats/index.js", import.meta.url).href;
	return await import(url) as UsageStatsModule;
}

export function parseUsageStatsRequest(value: unknown): UsageStatsRequest {
	const fail = (): never => {
		throw new RequestError(ERROR_INVALID_PARAMS, `${PIX_USAGE_STATS_METHOD} requires cwd, optional known sources and optional boolean refresh`);
	};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
	const record = value as Record<string, unknown>;
	if (typeof record.cwd !== "string" || record.cwd.trim().length === 0) return fail();
	if (record.refresh !== undefined && typeof record.refresh !== "boolean") return fail();
	let sources: UsageSourceId[] | undefined;
	if (record.sources !== undefined) {
		if (!Array.isArray(record.sources) || record.sources.length > 16 || !record.sources.every(isUsageSourceId)) return fail();
		sources = [...new Set(record.sources as UsageSourceId[])];
	}
	return {
		cwd: record.cwd,
		...(sources ? { sources } : {}),
		...(record.refresh === true ? { refresh: true } : {}),
	};
}

/**
 * Owns one usage service over every project's Pix sessions. Change
 * notifications go to the most recent requester's client; the request `cwd`
 * is validated but not used for collection (Desktop scopes client-side).
 */
export class UsageStatsHost {
	private modulePromise: Promise<UsageStatsModule> | undefined;
	private service: UsageStatsServiceLike | undefined;
	private notifier: UsageStatsNotifier | undefined;
	private disposed = false;
	private readonly load: () => Promise<UsageStatsModule>;

	constructor(private readonly options: { logger: Logger; agentDir?: string; load?: () => Promise<UsageStatsModule> }) {
		this.load = options.load ?? loadUsageStatsModule;
	}

	async stats(request: UsageStatsRequest, notify: UsageStatsNotifier): Promise<UsageStatsResponse> {
		if (this.disposed) throw new RequestError(ERROR_SERVER, "Usage statistics are unavailable");
		this.notifier = notify;
		const module = await this.module();
		if (this.disposed) throw new RequestError(ERROR_SERVER, "Usage statistics are unavailable");
		this.service ??= new module.UsageStatsService({
			sources: module.createUsageStatsSources({ log: this.log, ...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}) }),
			onChange: (source) => this.emit({ source }),
			log: this.log,
		});
		await this.service.restore();
		if (this.disposed) throw new RequestError(ERROR_SERVER, "Usage statistics are unavailable");
		const snapshots = this.service.request({
			...(request.sources ? { sources: request.sources } : {}),
			...(request.refresh === true ? { refresh: true } : {}),
		});
		return { snapshots };
	}

	/** Test/shutdown helper: resolves when every in-flight collection finished. */
	async settled(): Promise<void> {
		await this.service?.settled();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.notifier = undefined;
		this.service?.dispose();
		this.service = undefined;
	}

	private async module(): Promise<UsageStatsModule> {
		this.modulePromise ??= this.load();
		try {
			return await this.modulePromise;
		} catch (error) {
			this.modulePromise = undefined;
			this.options.logger.error(`usage_stats.module_unavailable ${error instanceof Error ? error.name : "Error"}`);
			throw new RequestError(ERROR_SERVER, "Usage statistics are unavailable");
		}
	}

	private emit(notification: UsageStatsChangedNotification): void {
		if (this.disposed) return;
		const notify = this.notifier;
		if (!notify) return;
		try {
			void notify(notification).catch(() => {});
		} catch {
			// A broken client must not affect collection.
		}
	}

	private readonly log: UsageStatsLog = (level, event, details) => {
		try {
			this.options.logger[level](details ? `${event} ${JSON.stringify(details)}` : event);
		} catch {
			// Logging must never change collection behavior.
		}
	};
}
