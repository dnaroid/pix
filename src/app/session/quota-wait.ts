/** Shared, UI-independent quota-wait state machine. Times are epoch milliseconds. */
export type QuotaWaitState = {
	version: 1;
	modelKey: string;
	reason: string;
	window: "hourly" | "weekly" | "unknown";
	resetAt?: number;
	nextCheckAt: number;
	autoResume: boolean;
	phase: "waiting" | "checking" | "resuming";
	attempt: number;
	mode?: "quota" | "timer";
	notBefore?: number;
};

export type QuotaCheck =
	| { kind: "available" }
	| { kind: "unknown" | "failed" }
	| { kind: "exhausted"; window: QuotaWaitState["window"]; resetAt?: number };

export type QuotaWaitHost = {
	now(): number;
	check(): Promise<QuotaCheck>;
	canResume(): boolean;
	resume(): void | Promise<void>;
	changed(state: QuotaWaitState | undefined): void;
};

export function parseQuotaWait(value: unknown): QuotaWaitState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const s = value as Partial<QuotaWaitState>;
	if (s.version !== 1 || typeof s.modelKey !== "string" || !s.modelKey
		|| typeof s.reason !== "string" || !["hourly", "weekly", "unknown"].includes(s.window ?? "")
		|| typeof s.autoResume !== "boolean" || !Number.isFinite(s.nextCheckAt)
		|| !Number.isSafeInteger(s.attempt) || s.attempt! < 0
		|| (s.resetAt !== undefined && !Number.isFinite(s.resetAt))
		|| (s.mode !== undefined && s.mode !== "quota" && s.mode !== "timer")
		|| (s.notBefore !== undefined && !Number.isFinite(s.notBefore))) return undefined;
	return { ...s, phase: "waiting" } as QuotaWaitState;
}

/** Deliberately excludes generic 429/rate-limit, billing and context/token-size failures. */
export function isQuotaExhaustion(error: string): boolean {
	if (!isQuotaCandidate(error)) return false;
	return /usage_limit_reached|weekly.{0,40}limit|hourly.{0,40}limit|(?:5|five)[ -]?hour.{0,40}limit|(?:usage|subscription|weekly|hourly) (?:cap|quota|limit).{0,40}(?:reached|exceeded|exhausted)|(?:hit|reached|exceeded) your (?:ChatGPT )?(?:usage )?limit|limit.{0,60}(?:resets|reset at)/i.test(error);
}

export function isQuotaCandidate(error: string): boolean {
	return !/billing|insufficient[_ ]quota|credit balance|payment required|context length|maximum context|invalid.api.key|unauthorized|authentication/i.test(error)
		&& /429|rate.?limit|quota|limit/i.test(error);
}

export function quotaFromError(error: string, now: number): QuotaCheck {
	const window = /week|seven.day|7.day/i.test(error) ? "weekly" : /hour|five.hour|5.hour/i.test(error) ? "hourly" : "unknown";
	const iso = error.match(/(?:reset(?:s)?(?:_at| at)?|retry at)[^\d]{0,8}(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/i)?.[1];
	const epoch = error.match(/["']?resets?_at["']?\s*[:=]\s*(\d{10,13})\b/i)?.[1];
	const relative = error.match(/(?:try again|retry|resets?) in\s*~?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
	let resetAt = iso ? Date.parse(iso) : epoch ? Number(epoch) * (epoch.length <= 10 ? 1000 : 1) : NaN;
	if (!Number.isFinite(resetAt) && relative) {
		const unit = relative[2]!.toLowerCase();
		resetAt = now + Number(relative[1]) * (unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000);
	}
	return { kind: "exhausted", window, ...(Number.isFinite(resetAt) && resetAt > now && resetAt - now < 32 * 86_400_000 ? { resetAt } : {}) };
}

export function quotaRetryDelay(attempt: number): number {
	return Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempt, 4));
}

/** Strict, additive units; rejects partial matches, zero and unreasonable timers. */
export function parseWaitDuration(input: string): number | undefined {
	if (!/^(?:\d+(?:\.\d+)?[dhms])+$/i.test(input)) return undefined;
	const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
	let duration = 0;
	for (const match of input.matchAll(/(\d+(?:\.\d+)?)([dhms])/gi)) duration += Number(match[1]) * units[match[2]!.toLowerCase()]!;
	return duration >= 1000 && duration <= 32 * 86_400_000 ? duration : undefined;
}

export function parseWaitDeadline(input: string, now: number): number | undefined {
	if (!/^until \d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(input)) return undefined;
	const deadline = Date.parse(input.slice(6));
	if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 32 * 86_400_000) return undefined;
	const date = input.slice(6, 16);
	return new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? deadline : undefined;
}

export class QuotaWaitController {
	state: QuotaWaitState | undefined;
	private generation = 0;
	private inFlight = false;
	private disposed = false;
	constructor(private readonly host: QuotaWaitHost) {}

	restore(state: QuotaWaitState): void {
		this.generation++;
		this.state = { ...state, phase: "waiting" };
		this.publish();
		void this.check(false, true);
	}

	wait(modelKey: string, reason: string, check: QuotaCheck): void {
		this.generation++;
		const previous = this.state;
		const attempt = previous ? previous.attempt + 1 : 0;
		this.state = {
			version: 1, modelKey, reason: reason.slice(0, 500),
			window: check.kind === "exhausted" ? check.window : "unknown",
			...(check.kind === "exhausted" && check.resetAt ? { resetAt: check.resetAt } : {}),
			nextCheckAt: this.nextCheck(check, attempt),
			autoResume: previous?.autoResume ?? true, phase: "waiting", attempt,
		};
		this.publish();
	}

	manual(modelKey: string, delay?: number): void {
		this.schedule(modelKey, delay === undefined ? undefined : this.host.now() + delay);
	}

	schedule(modelKey: string, notBefore?: number): void {
		this.generation++;
		const now = this.host.now();
		this.state = { version: 1, modelKey, reason: notBefore === undefined ? "Waiting for usage reset" : "Scheduled continuation",
			window: "unknown", mode: notBefore === undefined ? "quota" : "timer",
			...(notBefore === undefined ? {} : { notBefore }), nextCheckAt: notBefore ?? now,
			autoResume: true, phase: "waiting", attempt: 0 };
		this.publish();
	}

	tick(): void {
		if (this.state?.autoResume && this.state.phase === "waiting" && this.host.now() >= this.state.nextCheckAt) void this.check();
	}

	cancel(): void {
		if (!this.state) return;
		this.generation++;
		this.state = { ...this.state, autoResume: false, phase: "waiting" };
		this.publish();
	}

	clear(): void {
		this.generation++;
		this.state = undefined;
		this.publish();
	}

	dispose(): void { this.disposed = true; this.generation++; }

	async check(force = false, restoring = false): Promise<void> {
		if (this.disposed || !this.state || this.inFlight || this.state.phase === "resuming") return;
		const generation = this.generation;
		this.inFlight = true;
		this.state = { ...this.state, phase: "checking" };
		this.publish();
		try {
			const result = await this.host.check().catch((): QuotaCheck => ({ kind: "failed" }));
			if (this.disposed || generation !== this.generation || !this.state) return;
			if (!force && this.state.notBefore && this.host.now() < this.state.notBefore) {
				this.state = { ...this.state, phase: "waiting", nextCheckAt: this.state.notBefore };
				this.publish();
				return;
			}
			const canTry = force || result.kind === "available" || result.kind === "unknown";
			if (canTry && (force || this.state.autoResume) && this.host.canResume()) {
				this.state = { ...this.state, phase: "resuming" };
				this.publish();
				try { await this.host.resume(); }
				catch { if (generation === this.generation && !this.disposed) this.defer(result); }
			} else if (restoring && result.kind === "available" && !this.state.autoResume) {
				this.clear();
			} else {
				this.defer(result);
			}
		} finally { this.inFlight = false; }
	}

	private defer(check: QuotaCheck): void {
		if (!this.state) return;
		const attempt = this.state.attempt + 1;
		const { resetAt: _oldReset, ...state } = this.state;
		this.state = { ...state, attempt, phase: "waiting", nextCheckAt: this.nextCheck(check, attempt),
			...(check.kind === "exhausted" ? { window: check.window, ...(check.resetAt ? { resetAt: check.resetAt } : {}) } : {}),
		};
		this.publish();
	}

	private nextCheck(check: QuotaCheck, attempt: number): number {
		const now = this.host.now();
		return check.kind === "exhausted" && check.resetAt && check.resetAt + 60_000 > now
			? check.resetAt + 60_000 : now + quotaRetryDelay(attempt);
	}
	private publish(): void { if (!this.disposed) this.host.changed(this.state ? { ...this.state } : undefined); }
}
