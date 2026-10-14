import { isPixOwnedHost } from "./native-pi-tui.js";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, string | number | boolean>;
type Scope = { project?: string | null; module: string; sessionId?: string };
export type SuiteDiagnosticSink = (level: Level, event: string, details: Fields, scope: Scope) => void | Promise<void>;

type SuiteRecord = { level: Level; event: string; details: Fields; scope: Scope };
type Options = {
	loadSink?: () => Promise<SuiteDiagnosticSink | undefined>;
	enabled?: () => boolean;
	debug?: () => boolean;
	now?: () => number;
};

const ERROR_TYPES = new Set([
	"Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError",
	"AggregateError", "AbortError", "TimeoutError", "NetworkError", "NotFoundError",
	"DcpJournalError", "SearchUnavailableError", "SubagentModelSelectionError",
	"OtherError", "UnknownFailure",
]);
const SOURCES = new Set(["code", "knowledge", "sessions", "tasks", "commits"]);
const ACTIONS = new Set(["spawn", "status", "wait", "result", "stop", "cleanup", "configure", "off", "reset-history"]);
const PHASES = new Set(["preflight", "resolve", "summary", "commit", "blocked", "degraded", "failed", "needs_continue", "candidate_failed"]);
const SCALAR_FIELDS = new Set(["count", "indexed", "total", "durationMs", "capacityGapTokens", "complete", "attempts", "skipped"]);

function sessionIdFromContext(context: unknown): string | undefined {
	try {
		const manager = (context as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager;
		const value = manager?.getSessionId?.();
		return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value) ? value : undefined;
	} catch { return undefined; }
}

/** Error messages, stacks, provider payloads and unknown thrown objects stay out of the shared log. */
export function diagnosticErrorType(error: unknown): string {
	try {
		if (!(error instanceof Error)) return "UnknownFailure";
		// Error.name is mutable and can itself contain caller-supplied content.
		return ERROR_TYPES.has(error.name)
			? error.name : "OtherError";
	} catch { return "UnknownFailure"; }
}

// Whitelist known operational causes; never accept an arbitrary exception message
// or user-controlled text as a classifier.
const DCP_REASONS = new Set([
	"live-head-only", "protected-budget-exceeded", "evidence-unknown",
	"summarizer-unavailable", "non-positive-gain", "missing-source",
	"budget-exhausted", "auto-compress-failed", "auto-failed", "preparation-failed",
	"auto-disabled", "stale-context-projection", "no-candidate",
]);
export function diagnosticDcpReason(reason: unknown): string {
	return typeof reason === "string" && DCP_REASONS.has(reason) ? reason : "other";
}

const MAX_PENDING = 32;
const MAX_KEYS = 128;
const REPEAT_WINDOW_MS = 60_000;

/** An optional Pix host dependency: standalone pi-tools-suite never needs Pix's dist/. */
async function loadPixSink(): Promise<SuiteDiagnosticSink | undefined> {
	try {
		const injected = (globalThis as Record<symbol, unknown>)[Symbol.for("pix.diagnostics.sink")];
		if (typeof injected === "function") return injected as SuiteDiagnosticSink;
		// Compatibility when invoked from the Pix source/bundled checkout rather
		// than an installed extension copy. A missing runtime is nonfatal.
		// From external/pi-tools-suite/src/lib/ to the Pix runtime root.
		const url = new URL("../../../../dist/app/logger.js", import.meta.url).href;
		const module = await import(url) as { logPixEvent?: SuiteDiagnosticSink };
		return typeof module.logPixEvent === "function" ? module.logPixEvent : undefined;
	} catch {
		return undefined;
	}
}

/**
 * No filesystem calls, timers or awaited operations in report().
 * Explicit scalar metadata only; never pass exception messages, tool output,
 * provider responses or user text. Pix's writer applies final redaction/bounds.
 */
export function createSuiteDiagnostics(options: Options = {}) {
	const enabled = options.enabled ?? isPixOwnedHost;
	const debug = options.debug ?? (() => process.env.PIX_LOG_LEVEL === "debug");
	const now = options.now ?? Date.now;
	const loadSink = options.loadSink ?? loadPixSink;
	const pending: SuiteRecord[] = [];
	const recent = new Map<string, { at: number; suppressed: number }>();
	let sink: SuiteDiagnosticSink | undefined;
	let resolving = false;
	let unavailable = false;

	function send(record: SuiteRecord): void {
		try {
			void Promise.resolve(sink?.(record.level, record.event, record.details, record.scope)).catch(() => {});
		} catch { /* Diagnostics must not change tool or lifecycle outcomes. */ }
	}

	function resolveSink(): void {
		if (resolving || unavailable) return;
		resolving = true;
		void Promise.resolve().then(loadSink).then((loaded) => {
			if (!loaded) { unavailable = true; pending.length = 0; return; }
			sink = loaded;
			for (const record of pending.splice(0)) send(record);
		}).catch(() => {
			unavailable = true;
			pending.length = 0;
		});
	}

	function report(level: Level, module: string, event: string, project?: string | null, fields: Fields = {}, context?: unknown): void {
		try {
			if (!enabled() || unavailable || (level === "debug" && !debug())) return;
			if (!/^[a-z][a-z0-9.-]{0,63}$/.test(module) || !/^[a-z][a-z0-9-]{0,63}$/.test(event)) return;
			// A fixed small set of caller-owned metadata keys, not arbitrary payloads.
			const details: Fields = {};
			for (const [key, value] of Object.entries(fields).slice(0, 8)) {
				if (SCALAR_FIELDS.has(key) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
					details[key] = value;
				} else if (key === "reason" && typeof value === "string") {
					details.reason = diagnosticDcpReason(value);
				} else if (typeof value === "string" && (
					(key === "source" && SOURCES.has(value))
					|| (key === "action" && ACTIONS.has(value))
					|| (key === "errorType" && ERROR_TYPES.has(value))
					|| (key === "phase" && PHASES.has(value))
				)) {
					details[key] = value;
				}
			}
			const sessionId = sessionIdFromContext(context);
			if (level === "warn" || level === "error") {
				const key = `${project ?? ""}\0${sessionId ?? ""}\0${module}\0${event}\0${details.source ?? ""}\0${details.action ?? ""}\0${details.errorType ?? ""}\0${details.reason ?? ""}\0${details.phase ?? ""}`;
				const at = now();
				const previous = recent.get(key);
				if (previous && at - previous.at < REPEAT_WINDOW_MS && at >= previous.at) {
					previous.suppressed++;
					return;
				}
				if (previous?.suppressed) details.suppressed = previous.suppressed;
				else if (recent.size >= MAX_KEYS) recent.delete(recent.keys().next().value!);
				recent.set(key, { at, suppressed: 0 });
			}
			const record = { level, event: `suite:${event}`, details, scope: { project, module: `suite.${module}`,
				...(sessionId ? { sessionId } : {}) } };
			if (sink) send(record);
			else if (pending.length < MAX_PENDING) { pending.push(record); resolveSink(); }
		} catch { /* Best effort only; including hostile/throwing metadata objects. */ }
	}

	return { report };
}

export const suiteDiagnostics = createSuiteDiagnostics();
