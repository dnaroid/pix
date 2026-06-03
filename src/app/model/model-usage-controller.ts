import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MODEL_USAGE_POLL_INTERVAL_MS, MODEL_USAGE_STATUS_TICK_MS } from "../constants.js";
import {
	formatModelUsageStatusLabel,
	modelUsageDescriptor,
	queryModelUsageStatus,
	type ModelUsageDescriptor,
	type ModelUsageStatus,
} from "./model-usage-status.js";

export type AppModelUsageQuery = (descriptor: ModelUsageDescriptor) => Promise<ModelUsageStatus | undefined>;

export type ModelUsageRefreshResult = "refreshed" | "unavailable" | "failed";

export type ModelUsageRefreshStart =
	| { kind: "started"; promise: Promise<ModelUsageRefreshResult> }
	| { kind: "in-flight" }
	| { kind: "unsupported" };

export type AppModelUsageControllerHost = {
	runtimeSession(): AgentSession | undefined;
	requestRender(reason: string): void;
};

export class AppModelUsageController {
	private activeModelKey: string | undefined;
	private readonly statuses = new Map<string, ModelUsageStatus>();
	private readonly inFlightModelKeys = new Set<string>();
	private readonly lastAttemptAt = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(
		private readonly host: AppModelUsageControllerHost,
		private readonly queryUsageStatus: AppModelUsageQuery = queryModelUsageStatus,
	) {}

	startPolling(): void {
		if (this.timer) return;

		this.timer = setInterval(() => {
			this.tick();
		}, MODEL_USAGE_STATUS_TICK_MS);
		this.timer.unref?.();
		this.tick(true);
	}

	stopPolling(): void {
		if (!this.timer) return;

		clearInterval(this.timer);
		this.timer = undefined;
	}

	observeSession(session: AgentSession | undefined): void {
		const changed = this.syncActiveModel(session);
		if (changed && this.activeModelKey) this.refresh();
	}

	statusLabel(): string {
		return formatModelUsageStatusLabel(this.activeStatus());
	}

	refreshNow(): ModelUsageRefreshStart {
		const session = this.host.runtimeSession();
		this.syncActiveModel(session);
		const descriptor = modelUsageDescriptor(session?.model);
		if (!descriptor) return { kind: "unsupported" };

		const promise = this.refresh(true, descriptor);
		return promise ? { kind: "started", promise } : { kind: "in-flight" };
	}

	private tick(force = false): void {
		this.syncActiveModel(this.host.runtimeSession());
		const descriptor = modelUsageDescriptor(this.host.runtimeSession()?.model);
		if (!descriptor) return;

		const lastAttemptAt = this.lastAttemptAt.get(descriptor.modelKey) ?? 0;
		if (force || Date.now() - lastAttemptAt >= MODEL_USAGE_POLL_INTERVAL_MS) {
			this.refresh(force, descriptor);
			return;
		}

		if (this.activeStatus()) this.host.requestRender("model:model-usage-controller");
	}

	private refresh(force = false, activeDescriptor?: ModelUsageDescriptor): Promise<ModelUsageRefreshResult> | undefined {
		const descriptor = activeDescriptor ?? modelUsageDescriptor(this.host.runtimeSession()?.model);
		if (!descriptor) return undefined;

		const modelKey = descriptor.modelKey;
		if (this.inFlightModelKeys.has(modelKey)) return undefined;

		const lastAttemptAt = this.lastAttemptAt.get(modelKey) ?? 0;
		if (!force && Date.now() - lastAttemptAt < MODEL_USAGE_POLL_INTERVAL_MS) return undefined;

		this.inFlightModelKeys.add(modelKey);
		this.lastAttemptAt.set(modelKey, Date.now());

		return this.queryUsageStatus(descriptor).then(
			(status) => {
				if (status) {
					this.statuses.set(modelKey, status);
					return "refreshed" as const;
				}

				this.statuses.delete(modelKey);
				return "unavailable" as const;
			},
			() => {
				// Keep the previous value for this model on transient network/auth failures.
				return "failed" as const;
			},
		).finally(() => {
			this.inFlightModelKeys.delete(modelKey);
			if (this.activeModelKey === modelKey) this.host.requestRender("model:model-usage-controller");
		});
	}

	private syncActiveModel(session: AgentSession | undefined): boolean {
		const nextModelKey = modelUsageDescriptor(session?.model)?.modelKey;
		if (nextModelKey === this.activeModelKey) return false;

		this.activeModelKey = nextModelKey;
		this.host.requestRender("model:model-usage-controller");
		return true;
	}

	private activeStatus(): ModelUsageStatus | undefined {
		return this.activeModelKey ? this.statuses.get(this.activeModelKey) : undefined;
	}
}
