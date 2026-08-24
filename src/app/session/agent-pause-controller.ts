import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { APP_ICONS } from "../icons.js";

export type AgentPauseState = "idle" | "pause-requested" | "paused" | "resuming";

export type AgentPauseControllerHost = {
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
	isCurrentSession(session: AgentSession): boolean;
};

type ShouldStopAfterTurn = NonNullable<AgentSession["agent"]["shouldStopAfterTurn"]>;

type AgentSessionInternals = {
	_isAgentRunActive: boolean;
	_systemPromptOverride?: unknown;
	_handlePostAgentRun(): Promise<boolean>;
	_flushPendingBashMessages(): void;
	_emitAgentSettled(): Promise<void>;
};

type SessionPauseRecord = {
	state: AgentPauseState;
	pauseBoundaryReached: boolean;
	pauseSettled?: Promise<void>;
	resolvePauseSettled?: () => void;
	originalHandlePostAgentRun: () => Promise<boolean>;
};

/**
 * Implements a turn-boundary pause without interrupting an active tool batch.
 *
 * The pinned SDK exposes Agent.shouldStopAfterTurn and Agent.continue(), but not a
 * session-level continuation method. The small private adapter below mirrors the
 * bookkeeping in AgentSession._runAgentPrompt so resumed runs still get retries,
 * compaction, queue draining, isStreaming, and agent_settled behavior.
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
		};
		this.records.set(session, record);
		session.subscribe((event) => {
			if (event.type === "agent_start" && record.state === "paused") {
				// A new prompt supersedes a paused continuation.
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

		const originalShouldStopAfterTurn = session.agent.shouldStopAfterTurn;
		const shouldStopAfterTurn: ShouldStopAfterTurn = async (context, signal) => {
			if (await originalShouldStopAfterTurn?.(context, signal)) {
				if (record.state === "pause-requested") {
					record.pauseBoundaryReached = false;
					this.setState(record, "idle");
				}
				return true;
			}

			if (record.state !== "pause-requested") return false;
			record.pauseBoundaryReached = true;
			return true;
		};
		session.agent.shouldStopAfterTurn = shouldStopAfterTurn;

		internals._handlePostAgentRun = async () => {
			if (record.state === "paused") return false;

			const pauseBoundaryReached = record.pauseBoundaryReached;
			record.pauseBoundaryReached = false;
			const shouldContinue = await record.originalHandlePostAgentRun();
			if (pauseBoundaryReached || record.state === "pause-requested") {
				if (shouldContinue || this.canContinue(session)) {
					record.pauseSettled = new Promise<void>((resolve) => {
						record.resolvePauseSettled = resolve;
					});
					this.setState(record, "paused");
					this.host.showToast("Agent paused after the current turn", "success");
					return false;
				}
				this.setState(record, "idle");
				return false;
			}
			return shouldContinue;
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
			try {
				// Continue exactly as AgentSession._runAgentPrompt would.
				await session.agent.continue();
				while (this.host.isCurrentSession(session)) {
					const shouldContinue = await record.originalHandlePostAgentRun();
					if (!shouldContinue || !this.host.isCurrentSession(session)) break;
					await session.agent.continue();
				}
			} finally {
				internals._systemPromptOverride = undefined;
				internals._flushPendingBashMessages();
				await internals._emitAgentSettled();
			}
		} catch (error) {
			this.setState(record, "paused");
			this.host.showToast(`Could not continue agent: ${errorMessage(error)}`, "error");
			return;
		}
		this.setState(record, "idle");
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

	private canContinue(session: AgentSession): boolean {
		const messages = session.agent.state.messages;
		const lastMessage = messages[messages.length - 1];
		return Boolean(lastMessage && lastMessage.role !== "assistant") || session.agent.hasQueuedMessages();
	}

	private sessionInternals(session: AgentSession): AgentSessionInternals {
		const internals = session as unknown as Partial<AgentSessionInternals>;
		if (typeof internals._handlePostAgentRun !== "function"
			|| typeof internals._flushPendingBashMessages !== "function"
			|| typeof internals._emitAgentSettled !== "function"
			|| typeof internals._isAgentRunActive !== "boolean"
			|| !("_systemPromptOverride" in internals)) {
			throw new Error("Agent pause is incompatible with this pi SDK version");
		}
		return internals as AgentSessionInternals;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
