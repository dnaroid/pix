import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { HeadsUpCheckResult, HeadsUpFeedback, HeadsUpLastCheck, HeadsUpNotice, HeadsUpPhase, HeadsUpSnapshot } from "./contract.js";
import { DEFAULT_HEADS_UP_MODEL, normalizeHeadsUpConfig, type HeadsUpConfig } from "./config.js";
import { HeadsUpContext, type ContextRecord, type MessageLike } from "./context.js";
import { parseHeadsUpResponse } from "./parser.js";
import { validObserverUsage } from "./usage.js";
import { HeadsUpNotices } from "./notices.js";

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
	/** Refresh before inference and before publishing a finding, never per streamed chunk. */
	readonly prepareContext?: () => void;
	/** Bound to the originating session manager, not a mutable active-session getter. */
	readonly accountUsage: (message: AssistantMessage) => void;
	readonly publish?: (snapshot: HeadsUpSnapshot) => void;
}

function after(ms: number, callback: () => void): () => void {
	const timer = setTimeout(callback, ms); timer.unref?.();
	return () => clearTimeout(timer);
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
	private readonly notices = new HeadsUpNotices();
	private revision = 0;
	private generation = 0;
	private active: AbortController | undefined;
	private stopExpiry: (() => void) | undefined;
	private stopEvidence: (() => void) | undefined;
	private evidencePending = false;
	private parentRunning = false;
	private evidenceRevision = 0;
	private noticesFresh = true;
	private noticeEvidence: readonly ContextRecord[] = [];
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

	constructor(private readonly options: HeadsUpControllerOptions) {
		this.now = options.now ?? Date.now; this.after = options.after ?? after;
		this.instanceId = options.instanceId ?? randomUUID();
		this.config = normalizeHeadsUpConfig(options.config);
		this.lastCheckAt = this.now();
	}
	get isEnabled(): boolean { return this.enabled; }
	get model(): string { return this.modelRef; }
	get currentNotice(): HeadsUpNotice | null { this.expire(); return this.noticesFresh ? this.notices.current : null; }
	snapshot(): HeadsUpSnapshot {
		const now = this.now();
		const reservations = this.currentReservations(now);
		const retained = this.notices.all.filter((card) => card.expiresAt > now);
		const notices = this.noticesFresh ? retained : [];
		return {
			version: 1, instanceId: this.instanceId, revision: this.revision,
			enabled: this.enabled, model: this.modelRef, phase: this.phase,
			checks: this.checks, inputTokens: this.inputTokens, outputTokens: this.outputTokens,
			notice: notices.find((card) => card.id === this.notices.current?.id) ?? notices[0] ?? null, notices,
			awaitingReview: !this.noticesFresh && retained.length > 0,
			details: {
				config: { ...this.config }, newTurns: Math.max(0, this.turns - this.checkedTurns),
				intervalEligibleAt: this.lastCheckAt + this.config.minIntervalMs,
				checksInWindow: reservations.length,
				inputCharsInWindow: reservations.reduce((sum, entry) => sum + entry.chars, 0),
				windowResetsAt: reservations.length ? Math.min(...reservations.map((entry) => entry.at + 3_600_000)) : null,
				lastCheck: this.lastCheck,
				feedback: this.notices.memory.summary,
				discoveryMultiplier: this.notices.memory.discoveryMultiplier,
				discoveryEligibleAt: this.lastCheckAt + this.config.minIntervalMs * this.notices.memory.discoveryMultiplier,
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
	private clearNotice(): void { this.stopExpiry?.(); this.stopExpiry = undefined; this.notices.clear(); this.noticeEvidence = []; this.noticesFresh = true; }
	private scheduleExpiry(): void {
		this.stopExpiry?.(); this.stopExpiry = undefined;
		if (!this.notices.all.length) return;
		const expiresAt = Math.min(...this.notices.all.map((card) => card.expiresAt));
		this.stopExpiry = this.after(Math.max(0, expiresAt - this.now()), () => { this.stopExpiry = undefined; this.expire(); });
	}
	private expire(): void {
		if (!this.notices.expire(this.now())) return;
		this.scheduleExpiry(); this.publish(); this.scheduleEvidence();
	}
	private completeLastCheck(token: number, result: HeadsUpCheckResult): boolean {
		if (this.lastCheckToken !== token || !this.lastCheck || this.lastCheck.finishedAt !== null) return false;
		const finishedAt = this.now();
		this.lastCheck = { ...this.lastCheck, finishedAt, durationMs: Math.max(0, finishedAt - this.lastCheck.startedAt), result };
		this.lastCheckToken = undefined;
		this.publish();
		return true;
	}
	private invalidate(): void {
		this.stopEvidence?.(); this.stopEvidence = undefined; this.evidencePending = false;
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
	noteAgentStart(): void {
		this.parentRunning = true;
		this.stopEvidence?.(); this.stopEvidence = undefined;
		this.evidenceRevision++;
		if (this.notices.all.length) this.evidencePending = true;
		this.suspendNotices();
	}
	/** Hide claims synchronously, without reading the projection or spending inference. */
	private suspendNotices(): void {
		if (!this.notices.all.length) return;
		if (!this.noticesFresh) return;
		this.noticesFresh = false;
		this.publish();
	}
	/** Message completion may precede persistence; the revision closes that race. */
	noteEvidenceChanged(): void {
		if (this.disposed || !this.enabled) return;
		this.evidenceRevision++;
		if (this.notices.all.length) this.evidencePending = true;
		this.suspendNotices();
	}
	noteAgentSettled(completed: boolean): void {
		this.parentRunning = false;
		if (!completed) { this.invalidateForLifecycle("agent stopped or failed"); return; }
		const newTurns = this.turns - this.checkedTurns;
		if (newTurns >= this.config.minTurns || (this.notices.all.length && newTurns > 0)) this.evidencePending = true;
		this.scheduleEvidence();
	}
	/** A coalesced evidence opportunity, not a fabricated primary turn or a forced check. */
	noteDelegatedCompletion(): void {
		if (this.disposed || !this.enabled) return;
		this.noteEvidenceChanged();
		this.evidencePending = true; this.scheduleEvidence();
	}
	private scheduleEvidence(): void {
		// Membership/feedback may change the interval while an opportunity is queued.
		this.stopEvidence?.(); this.stopEvidence = undefined;
		if (!this.evidencePending || this.active || this.parentRunning || this.disposed || !this.enabled) return;
		const wait = Math.max(0, this.lastCheckAt + this.automaticInterval() - this.now());
		if (wait > 0 && !this.notices.all.length && this.notices.memory.discoveryMultiplier > 1) {
			this.refuse("cooldown", "new discovery slowed after explicit negative feedback");
		}
		this.stopEvidence = this.after(wait, () => {
			this.stopEvidence = undefined; void this.check().catch(() => {});
		});
	}
	private automaticInterval(): number {
		// Hidden cards remain review candidates: feedback must never delay their review.
		return this.config.minIntervalMs * (this.notices.all.length ? 1 : this.notices.memory.discoveryMultiplier);
	}
	noteTurn(message: MessageLike, id: string, results: readonly MessageLike[], resultIds: readonly string[]): void {
		if (this.disposed) return;
		this.turns++; this.context.addTurn(message, id, results, resultIds);
		this.suspendChangedNotices();
		// Let status consumers observe completed-turn cadence without waiting for inference.
		if (this.enabled) this.publish();
	}
	invalidateForLifecycle(reason: string, clearContext = false): void {
		if (this.disposed) return;
		this.invalidate(); this.checkedTurns = this.turns;
		// A new prompt is a conservative task boundary, not an inferred user profile.
		if (reason === "new user request" || clearContext) this.notices.memory.resetTask();
		if (clearContext) this.context.reset();
		this.phase = this.enabled ? "idle" : "off"; this.reason = reason; this.publish();
	}
	private refuse(phase: HeadsUpPhase, reason: string): false {
		if (this.phase !== phase || this.reason !== reason) { this.phase = phase; this.reason = reason; this.publish(); }
		return false;
	}
	private suspendChangedNotices(): void {
		if (this.notices.all.length && this.context.evidenceChanged(this.noticeEvidence, this.notices.all.flatMap((card) => card.evidence.map((entry) => entry.id)))) this.suspendNotices();
	}
	async check(explicit = false): Promise<boolean> {
		this.expire();
		this.suspendChangedNotices();
		if (this.disposed || !this.enabled) return false;
		if (!(this.options.allowed?.() ?? true)) { this.setEnabled(false); return false; }
		if (!explicit && this.parentRunning) return false;
		if (this.active) return this.refuse(this.active.signal.aborted ? "cooldown" : "checking", "waiting for the current request to finish");
		if (!explicit && ((!this.evidencePending && (this.notices.all.length || this.turns - this.checkedTurns < this.config.minTurns)) || this.now() - this.lastCheckAt < this.automaticInterval())) return false;
		// Consume once even when limited/unavailable: no timer polling or budget bypass.
		this.evidencePending = false; this.stopEvidence?.(); this.stopEvidence = undefined;
		this.reservations = this.currentReservations();
		if (this.reservations.length >= this.config.maxChecksPerHour) return this.refuse("limited", "hourly check limit reached");
		if (this.accountingFailed || !this.options.canAccountUsage()) return this.refuse("unavailable", "usage accounting unavailable");
		const model = this.options.findModel(this.modelRef);
		if (!model) return this.refuse("unavailable", "configured model unavailable; no fallback used");
		try { this.options.prepareContext?.(); } catch { this.suspendNotices(); return this.refuse("unavailable", "session context unavailable"); }
		this.suspendChangedNotices();
		const reviewing = this.notices.all;
		const stackVersion = this.notices.version;
		if (!explicit && this.noticesFresh && reviewing.length && !this.context.evidenceChanged(this.noticeEvidence, reviewing.flatMap((card) => card.evidence.map((entry) => entry.id)))) return false;
		const activeNotices = reviewing.map(({ id, title, consequence, topic, subject }) => ({ id, title, consequence, ...(topic && subject ? { topic, subject } : {}) }));
		const input = this.context.toInput(this.config.maxInputChars, [], activeNotices, this.notices.memory.records);
		const evidence = this.context.snapshot();
		const evidenceRevision = this.evidenceRevision;
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
			this.scheduleEvidence();
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
			const result = parseHeadsUpResponse(message, input.records, this.now(), this.config.noticeTtlMs, reviewing);
			if (result.kind === "invalid") {
				this.phase = "error"; this.reason = "invalid or incomplete observer reply";
				this.completeLastCheck(token, "invalid"); return false;
			}
			this.expire();
			if (this.notices.version !== stackVersion) {
				this.phase = "cooldown"; this.reason = "reviewed notice closed";
				this.completeLastCheck(token, "cancelled"); return false;
			}
			if (result.kind === "notice" || reviewing.length) {
				// A valid source ID only proves provenance, not that the observation is
				// still current. Read persisted results even before the next turn_end.
				try { this.options.prepareContext?.(); } catch {
					this.suspendNotices();
					this.phase = "unavailable"; this.reason = "session context unavailable";
					this.completeLastCheck(token, "cancelled"); return false;
				}
				const citedIds = [...reviewing, ...(result.kind === "notice" ? result.notices : [])].flatMap((card) => card.evidence.map((entry) => entry.id));
				if (this.parentRunning || evidenceRevision !== this.evidenceRevision || this.context.evidenceChanged(evidence, citedIds)) {
					this.suspendNotices();
					this.evidencePending = true;
					this.phase = "cooldown";
					this.reason = this.parentRunning ? "agent running; awaiting fresh check" : "evidence changed; awaiting fresh check";
					this.completeLastCheck(token, "cancelled"); return false;
				}
			}
			this.phase = "cooldown"; this.reason = "no actionable note";
			this.notices.apply(result.kind === "notice" ? result.notices : []);
			this.noticesFresh = true;
			this.noticeEvidence = evidence; this.scheduleExpiry();
			if (this.notices.all.length) {
				this.reason = undefined; this.completeLastCheck(token, "notice"); return true;
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
			this.scheduleEvidence();
		}
	}
	private recordUsage(message: AssistantMessage): void {
		if (!validObserverUsage(message.usage)) { this.accountingFailed = true; return; }
		const usage: Usage = message.usage;
		this.inputTokens += usage.input + usage.cacheRead + usage.cacheWrite; this.outputTokens += usage.output;
		try { this.options.accountUsage(message); } catch { this.accountingFailed = true; }
		this.publish(); // Suppressed on disposed runtime, but usage above still belongs to that runtime.
	}
	feedbackNotice(id: string, feedback: HeadsUpFeedback): boolean {
		this.expire();
		if (!this.notices.feedback(id, feedback)) return false;
		this.scheduleExpiry(); this.publish(); this.scheduleEvidence(); return true;
	}
	selectNotice(direction: -1 | 1): boolean {
		this.expire(); if (!this.noticesFresh || !this.notices.select(direction)) return false;
		this.publish(); return true;
	}
	explain(id?: string): HeadsUpNotice | null { this.expire(); return this.noticesFresh ? (id ? this.notices.all.find((card) => card.id === id) ?? null : this.notices.current) : null; }
	dispose(): void {
		if (this.disposed) return;
		this.invalidate(); this.enabled = false; this.phase = "off"; this.reason = undefined; this.publish(); this.disposed = true;
	}
}
