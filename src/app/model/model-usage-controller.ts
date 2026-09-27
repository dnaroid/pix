import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { MODEL_USAGE_POLL_INTERVAL_MS, MODEL_USAGE_STATUS_TICK_MS } from "../constants.js";
import { parseModelRef } from "./model-ref.js";
import {
	anthropicUsageStatusFromResponseHeaders,
	type ModelUsageResponseHeadersPayload,
} from "./anthropic-header-usage.js";
import type { SessionModel } from "../types.js";
import {
	formatModelUsageStatusLabel,
	modelUsageDescriptor,
	queryModelUsageStatus,
	resolveAnthropicAuthKind,
	type AnthropicAuthKind,
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
	draftSelection?(): { model: SessionModel; thinkingLevel: string } | undefined;
	/**
	 * Classifies the Anthropic credential as OAuth (`sk-ant-oat`) or API key.
	 * Secret-free; injectable for tests. Defaults to Pi auth resolution.
	 */
	anthropicAuthKind?(): Promise<AnthropicAuthKind>;
	render(): void;
};

function descriptorCacheKey(descriptor: ModelUsageDescriptor | undefined): string | undefined {
	if (!descriptor) return undefined;
	if (descriptor.kind !== "google-antigravity") return descriptor.modelKey;
	return `${descriptor.modelKey}\0${(descriptor.quotaModelCandidates ?? [descriptor.quotaModelKey]).join("|")}`;
}

export class AppModelUsageController {
	private activeModelKey: string | undefined;
	private readonly statuses = new Map<string, ModelUsageStatus>();
	// Anthropic API-key usage is captured from real Messages response headers,
	// so each sample belongs to exactly one session/model route and must never
	// leak into another session's status (accounts and models can differ per tab).
	private readonly headerStatuses = new Map<string, ModelUsageStatus>();
	private readonly inFlightModelKeys = new Set<string>();
	private readonly lastAttemptAt = new Map<string, number>();
	private anthropicAuthKind: AnthropicAuthKind | undefined;
	private anthropicAuthKindInFlight: Promise<void> | undefined;
	private anthropicAuthKindResolvedAt = 0;
	private pendingResponseHeaders: { payload: ModelUsageResponseHeadersPayload; now: number } | undefined;
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

	/**
	 * Record usage parsed from Anthropic Messages response headers observed on
	 * a live session response. This performs no network I/O: the headers ride
	 * on model traffic the session already generated. Only API-key sessions
	 * consume header samples; OAuth sessions keep polling `api/oauth/usage`,
	 * whose subscription windows are the binding constraint, so their header
	 * samples are ignored rather than mixed into the endpoint status.
	 */
	observeResponseHeaders(payload: ModelUsageResponseHeadersPayload, now = Date.now()): boolean {
		let parsedModel: { provider: string; modelId: string };
		try {
			parsedModel = parseModelRef(payload.modelRef);
		} catch {
			return false;
		}

		const descriptor = modelUsageDescriptor({ provider: parsedModel.provider, id: parsedModel.modelId } as SessionModel);
		if (!descriptor || descriptor.kind !== "anthropic") return false;
		if (this.anthropicAuthKind !== "api-key") {
			// Retain the first response while local auth resolution is pending.
			// OAuth responses are never used as API-key rate-limit telemetry.
			if (!this.anthropicAuthKind) this.pendingResponseHeaders = { payload, now };
			this.ensureAnthropicAuthKind();
			return false;
		}

		const status = anthropicUsageStatusFromResponseHeaders(payload.headers, descriptor.modelKey, now);
		if (!status) return false;

		const key = headerStatusKey(payload.sessionId, descriptorCacheKey(descriptor)!);
		this.headerStatuses.set(key, status);
		if (this.isActiveHeaderStatus(payload.sessionId, descriptorCacheKey(descriptor)!)) this.host.render();
		return true;
	}

	/**
	 * Drop header-captured usage for a session instance that is being torn
	 * down (tab/runtime disposal or in-place session replacement). A session
	 * can later be reopened under the same session ID; its fresh incarnation
	 * must not inherit the previous incarnation's rate-limit samples, which
	 * describe windows that have long since rolled over. Samples owned by
	 * other, concurrently open sessions are preserved.
	 */
	forgetSessionSamples(sessionId: string): void {
		if (this.pendingResponseHeaders?.payload.sessionId === sessionId) {
			this.pendingResponseHeaders = undefined;
		}
		if (this.headerStatuses.size === 0) return;

		const prefix = `${sessionId}\0`;
		let removed = false;
		for (const key of [...this.headerStatuses.keys()]) {
			if (!key.startsWith(prefix)) continue;
			this.headerStatuses.delete(key);
			removed = true;
		}
		if (removed && this.host.runtimeSession()?.sessionId === sessionId) this.host.render();
	}

	statusLabel(): string {
		return formatModelUsageStatusLabel(this.activeStatus());
	}

	refreshNow(): ModelUsageRefreshStart {
		const session = this.host.runtimeSession();
		this.syncActiveModel(session);
		const descriptor = this.activeDescriptor(session);
		if (!descriptor || this.isAnthropicHeaderOnly(descriptor)) return { kind: "unsupported" };

		const promise = this.refresh(true, descriptor);
		return promise ? { kind: "started", promise } : { kind: "in-flight" };
	}

	private tick(force = false): void {
		const session = this.host.runtimeSession();
		this.syncActiveModel(session);
		const descriptor = this.activeDescriptor(session);
		if (!descriptor) return;
		const cacheKey = descriptorCacheKey(descriptor)!;

		if (this.isAnthropicHeaderOnly(descriptor)) {
			// Anthropic API-key usage is header-driven; the tick only repaints
			// captured countdowns and never schedules provider quota I/O.
			if (this.activeStatus()) this.host.render();
			return;
		}

		if (descriptor.kind === "anthropic") this.ensureAnthropicAuthKind();

		const lastAttemptAt = this.lastAttemptAt.get(cacheKey) ?? 0;
		if (force || Date.now() - lastAttemptAt >= MODEL_USAGE_POLL_INTERVAL_MS) {
			this.refresh(force, descriptor);
			return;
		}

		if (this.activeStatus()) this.host.render();
	}

	/**
	 * True while the active Anthropic route must derive usage exclusively from
	 * observed response headers (API-key auth, or auth classification still
	 * pending after a previous attempt). OAuth sessions return false and keep
	 * the endpoint polling cadence.
	 */
	private isAnthropicHeaderOnly(descriptor: ModelUsageDescriptor): boolean {
		if (descriptor.kind !== "anthropic") return false;
		this.ensureAnthropicAuthKind();
		return this.anthropicAuthKind !== "oauth";
	}

	private ensureAnthropicAuthKind(): void {
		const resolve = this.host.anthropicAuthKind ?? resolveAnthropicAuthKind;
		if (this.anthropicAuthKindInFlight) return;
		// Re-classify at the polling cadence so mid-session logins/logouts
		// (api key <-> OAuth) are picked up without restarting the app.
		if (this.anthropicAuthKindResolvedAt > 0 && Date.now() - this.anthropicAuthKindResolvedAt < MODEL_USAGE_POLL_INTERVAL_MS) return;

		const attempt = resolve()
			.then((kind) => {
				if (this.anthropicAuthKind === kind) return;
				this.anthropicAuthKind = kind;
				this.purgeStaleAnthropicUsage(kind);
			})
			.catch(() => {
				// Keep the previous classification; classification is retried on
				// the next tick because `anthropicAuthKindResolvedAt` stays stale.
			})
			.finally(() => {
				this.anthropicAuthKindResolvedAt = Date.now();
				this.anthropicAuthKindInFlight = undefined;
				const pending = this.pendingResponseHeaders;
				this.pendingResponseHeaders = undefined;
				if (pending && this.anthropicAuthKind === "api-key") this.observeResponseHeaders(pending.payload, pending.now);
				// Re-evaluate against the CURRENT active route: the session or
				// model may have changed while classification was in flight.
				const session = this.host.runtimeSession();
				if (this.activeDescriptor(session)?.kind !== "anthropic") return;
				if (this.anthropicAuthKind === "oauth") this.refresh();
				this.host.render();
			});
		this.anthropicAuthKindInFlight = attempt;
	}

	/**
	 * Drop usage captured under the previous auth kind when it changes
	 * mid-session, so a stale header sample can never shadow the oauth/usage
	 * endpoint status (or vice versa) after a login switch.
	 */
	private purgeStaleAnthropicUsage(kind: AnthropicAuthKind): void {
		if (kind === "oauth") {
			this.headerStatuses.clear();
			return;
		}
		for (const modelKey of this.statuses.keys()) {
			if (modelKey.startsWith("anthropic/")) this.statuses.delete(modelKey);
		}
	}

	private refresh(force = false, activeDescriptor?: ModelUsageDescriptor): Promise<ModelUsageRefreshResult> | undefined {
		const session = this.host.runtimeSession();
		const descriptor = activeDescriptor ?? this.activeDescriptor(session);
		if (!descriptor) return undefined;
		// Anthropic API-key quota comes exclusively from observed response
		// headers; no usage endpoint request is issued for it.
		if (descriptor.kind === "anthropic" && this.anthropicAuthKind !== "oauth") {
			this.ensureAnthropicAuthKind();
			return undefined;
		}

		const modelKey = descriptorCacheKey(descriptor)!;
		if (this.inFlightModelKeys.has(modelKey)) return undefined;

		const lastAttemptAt = this.lastAttemptAt.get(modelKey) ?? 0;
		if (!force && Date.now() - lastAttemptAt < MODEL_USAGE_POLL_INTERVAL_MS) return undefined;

		this.inFlightModelKeys.add(modelKey);
		this.lastAttemptAt.set(modelKey, Date.now());

		return this.queryUsageStatus(descriptor).then(
			(status) => {
			// An OAuth lookup may finish after the credential changed to an API
			// key. Never reintroduce its subscription window in that session.
			if (descriptor.kind === "anthropic" && this.anthropicAuthKind !== "oauth") return "unavailable" as const;
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
			if (this.activeModelKey === modelKey) this.host.render();
		});
	}

	private syncActiveModel(session: AgentSession | undefined): boolean {
		const nextModelKey = descriptorCacheKey(this.activeDescriptor(session));
		if (nextModelKey === this.activeModelKey) return false;

		this.activeModelKey = nextModelKey;
		this.host.render();
		return true;
	}

	private activeStatus(): ModelUsageStatus | undefined {
		if (!this.activeModelKey) return undefined;

		const session = this.host.runtimeSession();
		if (session) {
			const headerStatus = this.headerStatuses.get(headerStatusKey(session.sessionId, this.activeModelKey));
			if (headerStatus) return headerStatus;
		}
		return this.statuses.get(this.activeModelKey);
	}

	private isActiveHeaderStatus(sessionId: string, cacheKey: string): boolean {
		if (this.activeModelKey !== cacheKey) return false;
		const session = this.host.runtimeSession();
		return session?.sessionId === sessionId;
	}

	private activeDescriptor(session: AgentSession | undefined): ModelUsageDescriptor | undefined {
		if (session) return modelUsageDescriptor(session.model, session.thinkingLevel);
		const draft = this.host.draftSelection?.();
		return draft ? modelUsageDescriptor(draft.model, draft.thinkingLevel) : undefined;
	}
}

function headerStatusKey(sessionId: string, cacheKey: string): string {
	return `${sessionId}\0${cacheKey}`;
}
