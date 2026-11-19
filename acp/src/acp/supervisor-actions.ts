import { SUPERVISOR_WORKER_PREAMBLE, type SupervisorMutation, type SupervisorStartItem } from "./supervisor-contract.js";
import { encodeSupervisorQuestionAnswer } from "./supervisor-question.js";
import type { SupervisorDigest, SupervisorLiveSession, SupervisorPendingQuestion } from "./supervisor-service.js";
import { parseSupervisorItem, type ManagedSession, type SupervisorMandate, type SupervisorRegistry, type SupervisorStore } from "./supervisor-store.js";

/**
 * Mutating `supervisor` tool operations (decision 0077, phase 2). Every op
 * runs under the project's supervisor lock, which user takeover shares, and
 * re-checks inside it: the caller is the registered supervisor, the mandate
 * is enabled and not paused, the session is managed in `managed` mode and
 * the limits allow the action. A refusal is an error the model sees; nothing
 * is queued for later.
 */

/** Session capabilities ACP lends the supervisor. */
export interface SupervisorActionRuntime {
	/** Run `operation` under the project's supervisor lock (shared with user takeover). */
	exclusive<T>(cwd: string, operation: () => Promise<T>): Promise<T>;
	/** Steer a busy session or queue a new turn for an idle one. */
	deliver(sessionId: string, text: string): Promise<"steering" | "queued">;
	question?(sessionId: string, questionId: string): SupervisorPendingQuestion | undefined;
	/** Submit only to the exact pending question; never enqueue a new turn. */
	answerQuestion?(sessionId: string, questionId: string, value: string): void;
	userPromptAt?(callerSessionId: string): number | undefined;
	cancel(sessionId: string): void;
	/**
	 * Launch an item through Desktop's Run actions with the worker rules
	 * prepended; resolves once the launch prompt is dispatched.
	 */
	launch(cwd: string, callerSessionId: string, item: SupervisorStartItem, modelRef: string | undefined): Promise<{ sessionId: string }>;
	/** Invalidate Desktop's session catalog after a worker's registration changed (start, close, reopen). */
	registered?(cwd: string, callerSessionId: string): void;
	/** Set a saved task's status; false when the task does not exist. */
	writeTaskStatus(cwd: string, taskId: string, status: "done" | "failed" | "in-progress"): Promise<boolean>;
	/** The session left the registry (closed by the supervisor). */
	released?(sessionId: string, cwd: string): void;
	/** Best-effort: after `close done` of a supervisor-started worker, close its Desktop tab. */
	autoCloseTab?(cwd: string, callerSessionId: string, sessionId: string): void;
}

export interface SupervisorActionDeps {
	readonly store: SupervisorStore;
	readonly runtime: SupervisorActionRuntime;
	live(sessionId: string): SupervisorLiveSession | undefined;
	digest(cwd: string, callerSessionId: string, sessionId: string): Promise<SupervisorDigest>;
	/** Stop reason of the session's last settled turn, when ACP saw it. */
	lastStopReason(sessionId: string): string | undefined;
	/** The session still exists in this project (saved or open). */
	sessionExists(cwd: string, sessionId: string): Promise<boolean>;
}

const MAX_LEDGER_TEXT = 500;
const MAX_EVIDENCE_FILES = 50;
const VERIFICATION_SECTION = /(^|\n)[ \t]*(?:#{1,6}[ \t]*|\*\*|__)?[ \t]*(?:verification|verified|проверк)/i;

/** Failing completion guards for `close outcome=done`; empty when all hold. */
export function completionGuardFailures(digest: SupervisorDigest, lastStopReason: string | undefined): string[] {
	const failures: string[] = [];
	// Pi's assistant messages say "stop" where ACP's settled turn says end_turn.
	const reportStop = digest.finalReport?.stopReason;
	const stopReason = lastStopReason ?? (reportStop === "stop" ? "end_turn" : reportStop);
	if (digest.run === "running") failures.push("a turn is still in flight");
	else if (stopReason !== "end_turn") failures.push(`last turn stop reason is ${stopReason ?? "unknown"}, not end_turn`);
	if (digest.pendingQuestion || digest.run === "question") failures.push("a question is pending");
	const plan = digest.plan;
	if (digest.planLookupFailed) failures.push("could not determine whether a plan is linked");
	if (plan) {
		if (!plan.progress) failures.push(`plan ${plan.path} is unreadable`);
		else if (plan.progress.total === 0) failures.push(`plan ${plan.path} has no checklist items`);
		else if (plan.progress.completed < plan.progress.total) {
			failures.push(`plan ${plan.path} has ${plan.progress.total - plan.progress.completed} unchecked item(s)`);
		}
	}
	if (!digest.finalReport) failures.push("no final assistant report");
	else if (!VERIFICATION_SECTION.test(digest.finalReport.text)) failures.push("final report has no verification section");
	return failures;
}

/** Managed-mode sessions with a turn in flight or a pending question. */
export function runningManagedSessions(
	registry: SupervisorRegistry,
	live: (sessionId: string) => SupervisorLiveSession | undefined,
	except?: string,
): number {
	let running = 0;
	for (const [sessionId, managed] of Object.entries(registry.sessions)) {
		if (sessionId === except || managed.mode !== "managed") continue;
		const state = live(sessionId);
		if (state && (state.running || state.pendingQuestions > 0)) running += 1;
	}
	return running;
}

function clip(text: string, max = MAX_LEDGER_TEXT): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withoutEscalation(session: ManagedSession): ManagedSession {
	const { escalation: _escalation, ...rest } = session;
	return rest;
}

export function createSupervisorActions(deps: SupervisorActionDeps) {
	const { store, runtime } = deps;

	function assertActive(mandate: SupervisorMandate): void {
		if (!mandate.enabled) throw new Error("Supervisor mandate is not enabled; ask the user to enable it in the supervisor header");
		if (mandate.paused) throw new Error("Supervisor is paused; no session actions until the user resumes it");
	}

	function managedSession(registry: SupervisorRegistry, sessionId: string): ManagedSession {
		const managed = registry.sessions[sessionId];
		if (!managed) throw new Error(`Session ${sessionId} is not managed by the supervisor`);
		if (managed.mode !== "managed") throw new Error(`Session ${sessionId} was taken over by the user; it is manual now`);
		return managed;
	}

	function openSession(sessionId: string): SupervisorLiveSession {
		const live = deps.live(sessionId);
		if (!live) throw new Error(`Session ${sessionId} is not open in Desktop; ask the user to open it`);
		return live;
	}

	async function journal(cwd: string, kind: string, sessionId: string | undefined, detail: Record<string, unknown>): Promise<void> {
		await store.appendLedger(cwd, { kind, ...(sessionId ? { sessionId } : {}), detail });
	}

	async function start(
		cwd: string,
		callerSessionId: string,
		request: Extract<SupervisorMutation, { op: "start" }>,
		mandate: SupervisorMandate,
		registry: SupervisorRegistry,
	) {
		const { item } = request;
		for (const [sessionId, entry] of Object.entries(registry.sessions)) {
			const same = item.kind === "task" ? entry.item.kind === "task" && entry.item.taskId === item.taskId
				: item.kind === "plan" && entry.item.kind === "plan" && entry.item.path === item.path;
			if (same) throw new Error(`Already registered as session ${sessionId}; use send, close or reopen instead of a duplicate start`);
		}
		if (runningManagedSessions(registry, deps.live) >= mandate.maxConcurrent) {
			throw new Error(`Concurrency limit reached (${mandate.maxConcurrent} managed sessions running); wait for one to settle`);
		}
		// A saved task keeps its own model; the mandate default covers plans and prompts.
		const modelRef = request.modelRef ?? (item.kind === "task" ? undefined : mandate.workerModelRef);
		// Held under the project lock: concurrent starts cannot both pass the limit.
		const { sessionId } = await runtime.launch(cwd, callerSessionId, item, modelRef);
		const registered = item.kind === "task" ? { kind: "task" as const, taskId: item.taskId }
			: item.kind === "plan" ? { kind: "plan" as const, path: item.path } : { kind: "prompt" as const };
		await store.updateRegistry(cwd, (current) => ({
			...current,
			sessions: { ...current.sessions, [sessionId]: current.sessions[sessionId]
				?? { item: registered, mode: "managed", registeredAt: Date.now(), reworkRounds: 0, briefed: true, origin: "started" as const } },
		}));
		runtime.registered?.(cwd, callerSessionId);
		await journal(cwd, "started", sessionId, { item: registered, ...(modelRef ? { modelRef } : {}),
			...(item.kind === "prompt" ? { text: clip(item.text) } : {}) });
		return { started: true, sessionId, item: registered,
			note: "The session is running with the worker rules; you get a digest when it settles." };
	}

	async function send(cwd: string, request: Extract<SupervisorMutation, { op: "send" }>, mandate: SupervisorMandate, registry: SupervisorRegistry) {
		const managed = managedSession(registry, request.sessionId);
		const live = openSession(request.sessionId);
		if (request.kind === "answer") throw new Error("send kind=answer cannot resolve a question; use supervisor read and op=answer instead");
		if (request.kind === "rework" && managed.reworkRounds >= mandate.maxReworkRounds) {
			throw new Error(`Rework limit reached (${managed.reworkRounds}/${mandate.maxReworkRounds}); escalate to the user instead`);
		}
		const startsTurn = !live.running && live.pendingQuestions === 0;
		if (startsTurn && runningManagedSessions(registry, deps.live, request.sessionId) >= mandate.maxConcurrent) {
			throw new Error(`Concurrency limit reached (${mandate.maxConcurrent} managed sessions running); wait for one to settle`);
		}
		const label = request.kind === "note" ? "Supervisor" : `Supervisor ${request.kind}`;
		// The first supervisor message a session gets carries the worker rules.
		const preamble = managed.briefed ? "" : `${SUPERVISOR_WORKER_PREAMBLE}\n\n`;
		const disposition = await runtime.deliver(request.sessionId, `${preamble}[${label}] ${request.text}`);
		const next = await store.updateRegistry(cwd, (current) => {
			const existing = current.sessions[request.sessionId];
			if (!existing) return current;
			const updated = { ...(existing.escalation?.questionId ? existing : withoutEscalation(existing)), briefed: true };
			return { ...current, sessions: { ...current.sessions, [request.sessionId]: request.kind === "rework"
				? { ...updated, reworkRounds: existing.reworkRounds + 1 } : updated } };
		});
		const reworkRounds = next.sessions[request.sessionId]?.reworkRounds ?? managed.reworkRounds;
		await journal(cwd, "sent", request.sessionId, { kind: request.kind, disposition, text: clip(request.text) });
		return { sent: true, disposition, reworkRounds, maxReworkRounds: mandate.maxReworkRounds };
	}

	function pendingQuestion(sessionId: string, questionId: string): SupervisorPendingQuestion {
		const question = runtime.question?.(sessionId, questionId);
		if (!question) throw new Error("Question is no longer pending (or the id is stale); use supervisor read before answering");
		return question;
	}

	async function answer(cwd: string, callerSessionId: string, request: Extract<SupervisorMutation, { op: "answer" }>, registry: SupervisorRegistry) {
		const { sessionId, questionId, authority, rationale, selections } = request;
		const managed = managedSession(registry, sessionId);
		const question = pendingQuestion(sessionId, questionId);
		const escalation = managed.escalation;
		if (authority === "mandate" && escalation?.questionId) {
			throw new Error("A question was escalated for this session; wait for the user's decision, or escalate the new question id if the worker asked again");
		}
		if (authority === "user" && (escalation?.questionId !== questionId || (runtime.userPromptAt?.(callerSessionId) ?? 0) <= escalation.at)) {
			throw new Error("User authority requires an escalation for this question and a subsequent user prompt in the supervisor session");
		}
		if (!runtime.answerQuestion) throw new Error("This host cannot answer worker questions");
		const encoded = encodeSupervisorQuestionAnswer(question.questions, selections);
		runtime.answerQuestion(sessionId, questionId, encoded);
		if (escalation?.questionId === questionId) {
			await store.updateRegistry(cwd, (current) => {
				const existing = current.sessions[sessionId];
				if (existing?.escalation?.questionId !== questionId) return current;
				return { ...current, sessions: { ...current.sessions, [sessionId]: withoutEscalation(existing) } };
			});
		}
		await journal(cwd, "answered", sessionId, { questionId, authority, rationale, selections });
		return { answered: true, questionId };
	}

	async function cancel(cwd: string, request: Extract<SupervisorMutation, { op: "cancel" }>, registry: SupervisorRegistry) {
		managedSession(registry, request.sessionId);
		const live = openSession(request.sessionId);
		if (!live.running) return { cancelled: false, reason: "no turn in flight" };
		runtime.cancel(request.sessionId);
		await journal(cwd, "cancelled", request.sessionId, {});
		return { cancelled: true };
	}

	async function close(
		cwd: string,
		callerSessionId: string,
		request: Extract<SupervisorMutation, { op: "close" }>,
		registry: SupervisorRegistry,
	) {
		const managed = managedSession(registry, request.sessionId);
		const digest = await deps.digest(cwd, callerSessionId, request.sessionId);
		const stopReason = deps.lastStopReason(request.sessionId);
		if (request.outcome === "done") {
			const failures = completionGuardFailures(digest, stopReason);
			if (failures.length > 0) {
				await journal(cwd, "close_refused", request.sessionId, { failures });
				return { closed: false, failures };
			}
		}
		const taskId = managed.item.kind === "task" ? managed.item.taskId : digest.task?.taskId;
		// The task is written first: a failed write leaves the session managed.
		const taskUpdated = taskId ? await runtime.writeTaskStatus(cwd, taskId, request.outcome) : false;
		await store.updateRegistry(cwd, (current) => {
			const { [request.sessionId]: _closed, ...sessions } = current.sessions;
			return { ...current, sessions };
		});
		await journal(cwd, "closed", request.sessionId, {
			outcome: request.outcome,
			// `reopen` restores the item and its rework count from this entry.
			item: managed.item,
			reworkRounds: managed.reworkRounds,
			...(managed.origin ? { origin: managed.origin } : {}),
			summary: clip(request.summary, 2_000),
			...(taskId ? { taskId, taskUpdated } : {}),
			evidence: {
				stopReason: stopReason ?? digest.finalReport?.stopReason ?? null,
				plan: digest.plan ?? null,
				touchedFiles: digest.touchedFiles.slice(-MAX_EVIDENCE_FILES),
				touchedFilesTotal: digest.touchedFilesTotal,
				report: digest.finalReport ? clip(digest.finalReport.text, 1_000) : null,
				messageCount: digest.messageCount,
			},
		});
		runtime.released?.(request.sessionId, cwd);
		// The tab marker comes from the catalog: refresh it, or the closed worker still looks managed.
		runtime.registered?.(cwd, callerSessionId);
		// Only supervisor-started workers close their tab: a handed-over
		// conversation belongs to the user, not to the supervisor.
		if (request.outcome === "done" && managed.origin === "started") runtime.autoCloseTab?.(cwd, callerSessionId, request.sessionId);
		return { closed: true, outcome: request.outcome, ...(taskId ? { taskId, taskUpdated } : {}) };
	}

	async function reopen(cwd: string, callerSessionId: string, request: Extract<SupervisorMutation, { op: "reopen" }>, registry: SupervisorRegistry) {
		if (registry.sessions[request.sessionId]) throw new Error(`Session ${request.sessionId} is already registered; nothing to reopen`);
		const closed = (await store.readLedger(cwd, 500)).filter((entry) => entry.sessionId === request.sessionId
			&& (entry.kind === "closed" || entry.kind === "reopened")).at(-1);
		const item = closed?.kind === "closed" ? parseSupervisorItem(closed.detail?.["item"]) : undefined;
		if (!closed || closed.kind !== "closed" || !item) {
			throw new Error(`Session ${request.sessionId} has no supervisor closure to reopen`);
		}
		if (!await deps.sessionExists(cwd, request.sessionId)) {
			throw new Error(`Session ${request.sessionId} no longer exists; start the item again instead`);
		}
		const rounds = closed.detail?.["reworkRounds"];
		const reworkRounds = typeof rounds === "number" && Number.isInteger(rounds) && rounds >= 0 ? rounds : 0;
		const taskId = item.kind === "task" ? item.taskId
			: typeof closed.detail?.["taskId"] === "string" ? closed.detail["taskId"] as string : undefined;
		const origin = closed.detail?.["origin"] === "started" || closed.detail?.["origin"] === "handed_over"
			? closed.detail["origin"] : undefined;
		const taskUpdated = taskId ? await runtime.writeTaskStatus(cwd, taskId, "in-progress") : false;
		await store.updateRegistry(cwd, (current) => current.sessions[request.sessionId] ? current : {
			...current,
			sessions: { ...current.sessions, [request.sessionId]: { item, mode: "managed", registeredAt: Date.now(), reworkRounds, briefed: true,
				...(origin ? { origin } : {}) } },
		});
		runtime.registered?.(cwd, callerSessionId);
		await journal(cwd, "reopened", request.sessionId, { ...(taskId ? { taskId, taskUpdated } : {}) });
		return { reopened: true, reworkRounds, ...(taskId ? { taskId, taskUpdated } : {}),
			note: "The session is managed again; send rework to start a new turn." };
	}

	async function escalate(cwd: string, request: Extract<SupervisorMutation, { op: "escalate" }>, assertCurrent: () => void) {
		const at = Date.now();
		if (request.sessionId) {
			const sessionId = request.sessionId;
			await store.updateRegistry(cwd, (current) => {
				assertCurrent();
				const existing = current.sessions[sessionId];
				if (!existing) throw new Error(`Session ${sessionId} is not managed by the supervisor`);
				if (request.questionId) {
					managedSession(current, sessionId);
					pendingQuestion(sessionId, request.questionId);
				}
				const priorId = existing.escalation?.questionId;
				if (priorId && priorId !== request.questionId && runtime.question?.(sessionId, priorId)) {
					throw new Error("A question escalation is already pending for this session");
				}
				// Repeating the escalation does not invalidate a user reply already received.
				const escalationAt = priorId && priorId === request.questionId ? existing.escalation!.at : at;
				return { ...current, sessions: { ...current.sessions, [sessionId]: { ...existing, escalation: {
					text: clip(request.text), at: escalationAt, ...(request.questionId ? { questionId: request.questionId } : {}),
				} } } };
			});
		}
		await journal(cwd, "escalated", request.sessionId, { text: clip(request.text, 2_000), ...(request.questionId ? { questionId: request.questionId } : {}) });
		return { escalated: true, note: "Now ask the user in your reply: state the decision needed, the options and your recommendation." };
	}

	return {
		/** `callerSessionId` must already be checked as the registered supervisor. */
		handle(cwd: string, callerSessionId: string, request: SupervisorMutation, callerIsCurrent = () => true): Promise<unknown> {
			return runtime.exclusive(cwd, async () => {
				const [mandate, registry] = await Promise.all([store.readMandate(cwd), store.readRegistry(cwd)]);
				// Re-checked under the lock: the supervisor may have been replaced.
				const assertCurrent = () => {
					if (!callerIsCurrent() || registry.supervisorSessionId !== callerSessionId) throw new Error("This runtime is no longer the project supervisor");
				};
				assertCurrent();
				// Escalation talks to the user; pause stops only session actions.
				if (request.op === "escalate") return escalate(cwd, request, assertCurrent);
				assertActive(mandate);
				switch (request.op) {
					case "start": return start(cwd, callerSessionId, request, mandate, registry);
					case "send": return send(cwd, request, mandate, registry);
					case "answer": return answer(cwd, callerSessionId, request, registry);
					case "cancel": return cancel(cwd, request, registry);
					case "close": return close(cwd, callerSessionId, request, registry);
					case "reopen": return reopen(cwd, callerSessionId, request, registry);
				}
			});
		},
	};
}
export type SupervisorActions = ReturnType<typeof createSupervisorActions>;
