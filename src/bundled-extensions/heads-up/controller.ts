import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { HeadsUpCheckResult, HeadsUpFeedback, HeadsUpLastCheck, HeadsUpNotice, HeadsUpPhase, HeadsUpSnapshot } from "./contract.js";
import { DEFAULT_HEADS_UP_MODEL, normalizeHeadsUpConfig, type HeadsUpConfig } from "./config.js";
import { HeadsUpContext, type MessageLike } from "./context.js";
import { parseHeadsUpResponse } from "./parser.js";
import { validObserverUsage } from "./usage.js";

export interface HeadsUpRequest {
	readonly model: Model<Api>; readonly input: string; readonly signal: AbortSignal;
	readonly maxTokens: number; readonly timeoutMs: number;
}
export interface HeadsUpControllerOptions {
	readonly now?: () => number;
	readonly instanceId?: string;
	readonly config?: Partial<HeadsUpConfig>;
	readonly after?: (ms: number, callback: () => void) => () => void;
	readonly request: (request: HeadsUpRequest) => Promise<AssistantMessage>;
	readonly findModel: (ref: string) => Model<Api> | undefined;
	readonly allowed?: () => boolean;
	readonly canAccountUsage: () => boolean;
	/** Refresh projected entries only when a check will run, not on every UI/event update. */
	readonly prepareContext?: () => void;
	/** Bound to the originating session manager, not a mutable active-session getter. */
	readonly accountUsage: (message: AssistantMessage) => void;
	readonly publish?: (snapshot: HeadsUpSnapshot) => void;
}

function after(ms: number, callback: () => void): () => void {
	const timer = setTimeout(callback, ms); timer.unref?.();
	return () => clearTimeout(timer);
}
function noteKey(notice: HeadsUpNotice): string {
	return `${notice.title} ${notice.consequence}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** One controller per runtime/session. Cancellation releases UI, NOT the physical request lock. */
export class HeadsUpController {
	readonly context = new HeadsUpContext();
	private readonly config: HeadsUpConfig;
	private readonly now: () => number;
	private readonly after: NonNullable<HeadsUpControllerOptions["after"]>;
	private readonly instanceId: string;
	private enabled = false;
	private disposed = false;
	private accountingFailed = false;
	private modelRef = DEFAULT_HEADS_UP_MODEL;
	private phase: HeadsUpPhase = "off";
	private reason: string | undefined;
	private notice: HeadsUpNotice | null = null;
	private revision = 0;
	private generation = 0;
	private active: AbortController | undefined;
	private stopExpiry: (() => void) | undefined;
	private checks = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private reservations: { at: number; chars: number }[] = [];
	private lastCheckAt: number;
	private lastCheck: HeadsUpLastCheck | null = null;
	/** Ties the public last-check record to its transport without exposing an internal token. */
	private lastCheckToken: number | undefined;
	private turns = 0;
	private checkedTurns = 0;
	private previous: string[] = [];
	private seen = new Set<string>();

	constructor(private readonly options: HeadsUpControllerOptions) {
		this.now = options.now ?? Date.now; this.after = options.after ?? after;
		this.instanceId = options.instanceId ?? randomUUID();
		this.config = normalizeHeadsUpConfig(options.config);
		this.lastCheckAt = this.now();
	}
	get isEnabled(): boolean { return this.enabled; }
	get model(): string { return this.modelRef; }
	get currentNotice(): HeadsUpNotice | null { this.expire(); return this.notice; }
	snapshot(): HeadsUpSnapshot {
		const now = this.now();
		const reservations = this.currentReservations(now);
		return {
			version: 1, instanceId: this.instanceId, revision: this.revision,
			enabled: this.enabled, model: this.modelRef, phase: this.phase,
			checks: this.checks, inputTokens: this.inputTokens, outputTokens: this.outputTokens,
			notice: this.notice && this.notice.expiresAt > now ? this.notice : null,
			details: {
				config: { ...this.config }, newTurns: Math.max(0, this.turns - this.checkedTurns),
				intervalEligibleAt: this.lastCheckAt + this.config.minIntervalMs,
				checksInWindow: reservations.length,
				inputCharsInWindow: reservations.reduce((sum, entry) => sum + entry.chars, 0),
				windowResetsAt: reservations.length ? Math.min(...reservations.map((entry) => entry.at + 3_600_000)) : null,
				lastCheck: this.lastCheck,
			},
			...(this.reason ? { reason: this.reason } : {}),
		};
	}
	/** Push factual state for a status consumer; never prepares context or starts inference. */
	refreshStatus(): void {
		this.expire();
		// A read may observe expired reservations, but never starts the next check.
		const reservations = this.currentReservations();
		if (this.enabled && !this.active && this.phase === "limited"
			&& (this.reason === "hourly check limit reached" && reservations.length < this.config.maxChecksPerHour
				|| this.reason === "hourly input limit reached" && reservations.length === 0)) {
			this.phase = "idle"; this.reason = undefined;
		}
		this.publish();
	}
	private currentReservations(now = this.now()): { at: number; chars: number }[] {
		return this.reservations.filter((entry) => entry.at > now - 3_600_000);
	}
	private publish(): void {
		if (this.disposed) return;
		this.revision++;
		try { this.options.publish?.(this.snapshot()); } catch { /* Optional UI never breaks inference. */ }
	}
	private clearNotice(): void { this.stopExpiry?.(); this.stopExpiry = undefined; this.notice = null; }
	private expire(): void { if (this.notice && this.notice.expiresAt <= this.now()) { this.clearNotice(); this.publish(); } }
	private completeLastCheck(token: number, result: HeadsUpCheckResult): boolean {
		if (this.lastCheckToken !== token || !this.lastCheck || this.lastCheck.finishedAt !== null) return false;
		const finishedAt = this.now();
		this.lastCheck = { ...this.lastCheck, finishedAt, durationMs: Math.max(0, finishedAt - this.lastCheck.startedAt), result };
		this.lastCheckToken = undefined;
		this.publish();
		return true;
	}
	private invalidate(): void {
		const active = this.active;
		const token = this.lastCheckToken;
		this.generation++;
		active?.abort();
		// Keep active until the actual transport settles, even if it ignores abort.
		if (token !== undefined) this.completeLastCheck(token, "cancelled");
		this.clearNotice();
	}
	setEnabled(value: boolean): void {
		if (this.disposed) return;
		this.invalidate();
		this.enabled = value && (this.options.allowed?.() ?? true);
		this.phase = this.enabled ? "idle" : "off";
		this.reason = value && !this.enabled ? "observer unavailable in this runtime" : undefined;
		this.publish();
	}
	setModel(ref: string): boolean {
		if (this.disposed || !/^[^\s/]+\/[^\s]+$/.test(ref) || ref.length > 256) return false;
		this.invalidate(); this.modelRef = ref;
		this.phase = this.enabled ? "idle" : "off"; this.reason = undefined; this.publish(); return true;
	}
	noteUserRequest(): void { this.invalidateForLifecycle("new user request"); }
	noteTurn(message: MessageLike, id: string, results: readonly MessageLike[], resultIds: readonly string[]): void {
		if (this.disposed) return;
		this.turns++; this.context.addTurn(message, id, results, resultIds);
		// Let status consumers observe completed-turn cadence without waiting for inference.
		if (this.enabled) this.publish();
	}
	invalidateForLifecycle(reason: string, clearContext = false): void {
		if (this.disposed) return;
		this.invalidate(); this.checkedTurns = this.turns;
		if (clearContext) this.context.reset();
		this.phase = this.enabled ? "idle" : "off"; this.reason = reason; this.publish();
	}
	private refuse(phase: HeadsUpPhase, reason: string): false {
		if (this.phase !== phase || this.reason !== reason) { this.phase = phase; this.reason = reason; this.publish(); }
		return false;
	}
	async check(explicit = false): Promise<boolean> {
		this.expire();
		if (this.disposed || !this.enabled) return false;
		if (!(this.options.allowed?.() ?? true)) { this.setEnabled(false); return false; }
		if (this.active) return this.refuse(this.active.signal.aborted ? "cooldown" : "checking", "waiting for the current request to finish");
		if (!explicit && (this.notice || this.turns - this.checkedTurns < this.config.minTurns || this.now() - this.lastCheckAt < this.config.minIntervalMs)) return false;
		this.reservations = this.currentReservations();
		if (this.reservations.length >= this.config.maxChecksPerHour) return this.refuse("limited", "hourly check limit reached");
		if (this.accountingFailed || !this.options.canAccountUsage()) return this.refuse("unavailable", "usage accounting unavailable");
		const model = this.options.findModel(this.modelRef);
		if (!model) return this.refuse("unavailable", "configured model unavailable; no fallback used");
		try { this.options.prepareContext?.(); } catch { return this.refuse("unavailable", "session context unavailable"); }
		const input = this.context.toInput(this.config.maxInputChars, this.previous);
		if (!input.records.some((entry) => entry.kind === "user") || !input.records.some((entry) => entry.kind !== "user")) return this.refuse("cooldown", "not enough user and work context");
		if (input.body.length > this.config.maxInputChars || this.reservations.reduce((sum, entry) => sum + entry.chars, 0) + input.body.length > this.config.maxInputCharsPerHour) return this.refuse("limited", "hourly input limit reached");
		const token = ++this.generation;
		const abort = new AbortController(); this.active = abort;
		const startedAt = this.now();
		this.phase = "checking"; this.reason = undefined; this.checks++;
		this.reservations.push({ at: startedAt, chars: input.body.length });
		this.lastCheckAt = startedAt; this.checkedTurns = this.turns;
		this.lastCheck = { startedAt, finishedAt: null, durationMs: null, result: "running" };
		this.lastCheckToken = token;
		this.publish();
		// Promise.resolve also contains synchronous provider exceptions.
		const transport = Promise.resolve().then(() => this.options.request({ model, input: input.body, signal: abort.signal, maxTokens: this.config.maxTokens, timeoutMs: this.config.timeoutMs }));
		const observed = transport.then((message) => { this.recordUsage(message); return message; }).finally(() => {
			if (this.active === abort) this.active = undefined;
		});
		let timedOut = false;
		const cancelTimeout = this.after(this.config.timeoutMs, () => {
			timedOut = true; abort.abort();
			if (token === this.generation && !this.disposed && this.enabled) {
				this.phase = "error"; this.reason = "check timed out";
				this.completeLastCheck(token, "timeout");
			}
		});
		let onAbort: () => void = () => {};
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("observer cancelled"));
			abort.signal.addEventListener("abort", onAbort, { once: true });
			if (abort.signal.aborted) onAbort();
		});
		try {
			const message = await Promise.race([observed, cancelled]);
			if (token !== this.generation || abort.signal.aborted || this.disposed || !this.enabled) return false;
			if (this.accountingFailed) {
				this.phase = "error"; this.reason = "usage could not be recorded";
				this.completeLastCheck(token, "error"); return false;
			}
			const result = parseHeadsUpResponse(message, input.records, this.now(), this.config.noticeTtlMs);
			if (result.kind === "invalid") {
				this.phase = "error"; this.reason = "invalid or incomplete observer reply";
				this.completeLastCheck(token, "invalid"); return false;
			}
			this.phase = "cooldown"; this.reason = "no actionable note";
			if (result.kind === "notice" && !this.seen.has(noteKey(result.notice))) {
				this.clearNotice(); this.notice = result.notice; this.reason = undefined;
				this.seen.add(noteKey(result.notice));
				while (this.seen.size > 32) this.seen.delete(this.seen.values().next().value!);
				this.remember(`Shown: ${result.notice.title}. ${result.notice.consequence}`);
				this.stopExpiry = this.after(this.config.noticeTtlMs, () => { this.stopExpiry = undefined; this.expire(); });
				this.completeLastCheck(token, "notice"); return true;
			}
			this.completeLastCheck(token, result.kind === "notice" ? "duplicate" : "none"); return false;
		} catch {
			if (token === this.generation && !this.disposed && this.enabled && this.lastCheck?.finishedAt === null) {
				this.phase = timedOut ? "error" : "cooldown";
				this.reason = timedOut ? "check timed out" : abort.signal.aborted ? "check cancelled" : "check failed";
				this.completeLastCheck(token, timedOut ? "timeout" : abort.signal.aborted ? "cancelled" : "error");
			}
			return false;
		} finally {
			cancelTimeout(); abort.signal.removeEventListener("abort", onAbort);
		}
	}
	private recordUsage(message: AssistantMessage): void {
		if (!validObserverUsage(message.usage)) { this.accountingFailed = true; return; }
		const usage: Usage = message.usage;
		this.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite; this.outputTokens += usage.output;
		try { this.options.accountUsage(message); } catch { this.accountingFailed = true; }
		this.publish(); // Suppressed on disposed runtime, but usage above still belongs to that runtime.
	}
	private remember(text: string): void { this.previous = [...this.previous, text].slice(-16); }
	feedbackNotice(id: string, feedback: HeadsUpFeedback): boolean {
		const notice = this.currentNotice;
		if (!notice || notice.id !== id) return false;
		this.remember(`${feedback}: ${notice.title}. ${notice.consequence}`);
		this.clearNotice(); this.publish(); return true;
	}
	explain(id?: string): HeadsUpNotice | null { const notice = this.currentNotice; return !id || notice?.id === id ? notice : null; }
	dispose(): void {
		if (this.disposed) return;
		this.invalidate(); this.enabled = false; this.phase = "off"; this.reason = undefined; this.publish(); this.disposed = true;
	}
}
