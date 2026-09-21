import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { APP_ICONS } from "../icons.js";

export type AgentPauseState = "idle" | "pause-requested" | "paused" | "resuming";

export type AgentPauseControllerHost = {
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
	isCurrentSession(session: AgentSession): boolean;
};

type FinishTurn = NonNullable<AgentSession["agent"]["finishTurn"]>;
type FinishTurnArgs = Parameters<FinishTurn>;

type AgentSessionInternals = {
	_isAgentRunActive: boolean;
	_agentRunAbortRequested: boolean;
	_runSystemPromptOptions?: unknown;
	_handlePostAgentRun(): Promise<boolean>;
	_runBeforeSettleBoundary(): Promise<boolean>;
	_flushPendingBashMessages(): void;
	_flushPendingCustomMessages(): void;
	_emitAgentSettled(): Promise<void>;
};

type SessionPauseRecord = {
	state: AgentPauseState;
	pauseBoundaryReached: boolean;
	pauseSettled?: Promise<void>;
	resolvePauseSettled?: () => void;
	originalHandlePostAgentRun: () => Promise<boolean>;
	originalRunBeforeSettleBoundary: () => Promise<boolean>;
};

/**
 * Implements a turn-boundary pause without interrupting an active tool batch.
 *
 * The pinned SDK exposes Agent.finishTurn and Agent.continue(), but not a
 * session-level continuation method. The small private adapter below mirrors the
 * AgentSession 0.87 _runAgentPrompt lifecycle so resumed runs retain retries,
 * compaction, before-settle extensions, queue draining, and settlement behavior.
 */
export class AgentPauseController {
	private readonly records = new WeakMap<AgentSession, SessionPauseRecord>();

	constructor(private readonly host: AgentPauseControllerHost) {}

	bind(session: AgentSession): void {
		if (this.records.has(session)) return;

		const internals = this.sessionInternals(session);
		const record: SessionPauseRecord = {
			state: "idle",
			pauseBoundaryReached: false,
			originalHandlePostAgentRun: internals._handlePostAgentRun.bind(session),
			originalRunBeforeSettleBoundary: internals._runBeforeSettleBoundary.bind(session),
		};
		this.records.set(session, record);
		session.subscribe((event) => {
			if (event.type === "agent_start" && (record.state === "paused" || record.state === "resuming")) {
				// A new prompt (including a resumed run) supersedes the paused state.
				this.setState(record, "idle");
			}
		});
		const originalEmitAgentSettled = internals._emitAgentSettled.bind(session);
		internals._emitAgentSettled = async () => {
			try {
				await originalEmitAgentSettled();
			} finally {
				this.finishSettlement(record);
			}
		};

		const originalFinishTurn = session.agent.finishTurn;
		const finishTurn = (async (turn: FinishTurnArgs[0], signal: FinishTurnArgs[1]) => {
			const priorDecision = await originalFinishTurn?.(turn, signal);
			if (priorDecision?.action === "end") {
				if (record.state === "pause-requested") {
					record.pauseBoundaryReached = false;
					this.setState(record, "idle");
				}
				return priorDecision;
			}
			// A previous hook's explicit continuation can end on an assistant
			// message. Agent.continue() cannot restart from that transcript shape,
			// so let the requested turn run and keep waiting for the next boundary.
			if (priorDecision?.action === "continue") return priorDecision;

			if (record.state !== "pause-requested" || signal?.aborted
				|| turn.message.stopReason === "aborted" || turn.message.stopReason === "error") {
				return priorDecision;
			}
			record.pauseBoundaryReached = true;
			return { action: "end" };
		}) as FinishTurn;
		session.agent.finishTurn = finishTurn;

		internals._handlePostAgentRun = async () => {
			if (record.state === "paused") return false;

			const pauseBoundaryReached = record.pauseBoundaryReached;
			const shouldContinue = await record.originalHandlePostAgentRun();
			if (internals._agentRunAbortRequested) {
				this.clearPauseRequest(record);
				return false;
			}
			if (pauseBoundaryReached || record.state === "pause-requested") {
				record.pauseBoundaryReached = false;
				if (shouldContinue) {
					this.pause(record);
					return false;
				}
				// 0.87 runs agent_before_settle after post-run bookkeeping. Let that
				// boundary commit its drafts and queues before deciding whether this
				// otherwise-resumable turn is a real pause.
				return false;
			}
			return shouldContinue;
		};

		internals._runBeforeSettleBoundary = async () => {
			if (record.state === "paused") return false;
			if (internals._agentRunAbortRequested) {
				this.clearPauseRequest(record);
				return false;
			}
			const shouldContinue = await record.originalRunBeforeSettleBoundary();
			if (record.state !== "pause-requested") return shouldContinue;
			if (internals._agentRunAbortRequested) {
				this.clearPauseRequest(record);
				return false;
			}
			record.pauseBoundaryReached = false;
			if (shouldContinue || this.canContinue(session)) {
				this.pause(record);
			} else {
				this.setState(record, "idle");
			}
			return false;
		};
	}

	state(session: AgentSession | undefined): AgentPauseState {
		if (!session) return "idle";
		return this.records.get(session)?.state ?? "idle";
	}

	statusWidgetText(session: AgentSession | undefined): string {
		return this.state(session) === "paused" ? APP_ICONS.play : APP_ICONS.pause;
	}

	statusWidgetActive(session: AgentSession | undefined): boolean {
		if (!session) return false;
		return this.state(session) !== "idle" || session.isStreaming || session.agent.state.isStreaming;
	}

	async toggle(session: AgentSession | undefined): Promise<void> {
		if (!session) {
			this.host.showToast("No active agent session", "info");
			return;
		}

		this.bind(session);
		const record = this.records.get(session)!;
		if (record.state === "paused") {
			await this.resume(session, record);
			return;
		}
		if (record.state === "pause-requested" || record.state === "resuming") return;

		if (!session.isStreaming && !session.agent.state.isStreaming) {
			this.host.showToast("Agent is not running", "info");
			return;
		}

		this.setState(record, "pause-requested");
		this.host.showToast("Pause requested; waiting for the current turn to finish", "info");
	}

	private async resume(session: AgentSession, record: SessionPauseRecord): Promise<void> {
		this.setState(record, "resuming");
		this.host.showToast("Continuing agent", "info");

		try {
			// isIdle becomes true before async agent_settled extension handlers finish,
			// so wait for the event itself rather than relying on waitForIdle().
			await record.pauseSettled;
			if (!this.host.isCurrentSession(session)) {
				throw new Error("agent session changed before it could continue");
			}
			const internals = this.sessionInternals(session);
			internals._isAgentRunActive = true;
			internals._agentRunAbortRequested = false;
			try {
				// Continue exactly as AgentSession._runAgentPrompt would.
				await session.agent.continue();
				while (this.host.isCurrentSession(session)) {
					const shouldContinue = await internals._handlePostAgentRun();
					if (shouldContinue) {
						if (internals._agentRunAbortRequested) break;
						await session.agent.continue();
						continue;
					}
					if (internals._agentRunAbortRequested || !await internals._runBeforeSettleBoundary()) break;
					await session.agent.continue();
				}
			} finally {
				internals._runSystemPromptOptions = undefined;
				internals._flushPendingBashMessages();
				internals._flushPendingCustomMessages();
				await internals._emitAgentSettled();
			}
		} catch (error) {
			this.setState(record, "paused");
			this.host.showToast(`Could not continue agent: ${errorMessage(error)}`, "error");
			return;
		}
		if (record.state === "resuming") this.setState(record, "idle");
	}

	private setState(record: SessionPauseRecord, state: AgentPauseState): void {
		if (record.state === state) return;
		record.state = state;
		this.host.render();
	}

	private finishSettlement(record: SessionPauseRecord): void {
		record.resolvePauseSettled?.();
		delete record.resolvePauseSettled;
		if (record.state === "pause-requested") {
			record.pauseBoundaryReached = false;
			this.setState(record, "idle");
		}
	}

	private pause(record: SessionPauseRecord): void {
		record.pauseSettled = new Promise<void>((resolve) => {
			record.resolvePauseSettled = resolve;
		});
		this.setState(record, "paused");
		this.host.showToast("Agent paused after the current turn", "success");
	}

	private clearPauseRequest(record: SessionPauseRecord): void {
		record.pauseBoundaryReached = false;
		if (record.state === "pause-requested") this.setState(record, "idle");
	}

	private canContinue(session: AgentSession): boolean {
		const messages = session.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		return Boolean(lastMessage && lastMessage.role !== "assistant") || session.agent.hasQueuedMessages();
	}

	private sessionInternals(session: AgentSession): AgentSessionInternals {
		const internals = session as unknown as Partial<AgentSessionInternals>;
		if (typeof internals._handlePostAgentRun !== "function"
			|| typeof internals._runBeforeSettleBoundary !== "function"
			|| typeof internals._flushPendingBashMessages !== "function"
			|| typeof internals._flushPendingCustomMessages !== "function"
			|| typeof internals._emitAgentSettled !== "function"
			|| typeof internals._isAgentRunActive !== "boolean"
			|| typeof internals._agentRunAbortRequested !== "boolean"
			|| !("_runSystemPromptOptions" in internals)) {
			throw new Error("Agent pause is incompatible with this pi SDK version");
		}
		return internals as AgentSessionInternals;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
