import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_SUPERVISOR_SUMMARY,
	MAX_SUPERVISOR_TEXT,
	SUPERVISOR_OPS,
	SUPERVISOR_SEND_KINDS,
	SUPERVISOR_TOOL,
	parseSupervisorToolRequest,
} from "../acp/supervisor-contract.js";

/**
 * `supervisor` agent tool (decision 0077, phases 1-2). ACP loads this
 * extension only into the project supervisor's runtime on Pix Desktop; worker,
 * headless and sub-agent runtimes never get it. Requests go to ACP through the
 * correlated bridge installed by `pi/supervisor-host.js`.
 */
const HOST = Symbol.for("pix.supervisor.request");

type SupervisorHost = (input: { ownerSessionId: string; op: string } & Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

export default function supervisorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUPERVISOR_TOOL,
		label: "Supervisor",
		description: "Project supervisor tool for this project's work sessions. "
			+ "op=status: mandate, pause state and limits, managed sessions and the project's other recent sessions, each with linked task, "
			+ "run state (running, question, idle, not-loaded), last lifecycle event (settled with stop reason, question, error, stalled, checklist) and linked plan progress. "
			+ "op=read {sessionId}: bounded digest of one session — last user messages, final assistant report with stop reason, pending question, "
			+ "recent tool errors and files changed through write/edit. Never a full transcript. "
			+ "Session actions need the mandate enabled and not paused, and act only on managed sessions: "
			+ "op=start {taskId | planPath | text, modelRef?} launches a saved task, a saved plan (.pi/plans/...) or a prompt in a new Desktop session with the worker rules and registers it as managed (counts against maxConcurrent; a task or plan already registered is refused); "
			+ "op=send {sessionId, text, kind: rework|answer|note} steers a busy session or queues a new turn (rework counts against maxReworkRounds; a new turn counts against maxConcurrent); "
			+ "op=cancel {sessionId} stops the turn in flight; "
			+ "op=close {sessionId, outcome: done|failed, summary} sets the linked task status and releases the session — done is refused unless the last turn ended with end_turn, no question is pending, the linked plan is fully checked and the final report has a verification section; "
			+ "op=reopen {sessionId} reverts your own close: the session is managed again with its item and rework count, and its task returns to in-progress; "
			+ "op=escalate {text, sessionId?} records that you need the user's decision (allowed while paused). "
			+ "Refusals are errors; nothing is queued for later.",
		promptSnippet: "Use supervisor for the project's work sessions: status/read to observe; send, cancel, close and escalate to act on sessions handed over to you.",
		promptGuidelines: [
			"supervisor: you are the project supervisor. Act only on managed sessions; sessions in manual mode belong to the user, observe them and report. Start work with start (task, plan or prompt) or ask the user to hand a session over. Started sessions get the worker rules (no commits, no destructive git, no mass rewrites, only relevant checks); your first send to a handed-over session prepends them. A start that fails or times out may still have launched: check status before retrying.",
			"supervisor close: use it, never project_tasks update, to finish a managed task. If done is refused, read the failing guards and send rework or escalate; do not retry the same close. Use reopen to revert a wrong close.",
			"supervisor digest events: interrupted means Pix quit during that session's turn — read it, then send rework to continue or close it; missing means the session was deleted — close it with outcome failed or escalate.",
			"supervisor escalate: when a decision is product, risky or outside the mandate policy, escalate and then ask the user in your reply with the options and your recommendation.",
			"supervisor read: judge finished work by the digest (final report, verification section, plan progress, tool errors) and tell the user whether it looks done or needs rework, with reasons.",
		],
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", enum: [...SUPERVISOR_OPS], description: "status, read, start, send, cancel, close, reopen or escalate." },
				sessionId: { type: "string", maxLength: 128, description: "Session id from status (read, send, cancel, close, reopen; optional for escalate)." },
				text: { type: "string", maxLength: MAX_SUPERVISOR_TEXT, description: "start: prompt for a new session; send: message for the session; escalate: the decision you need from the user." },
				taskId: { type: "string", maxLength: 128, description: "start: saved task id to run." },
				planPath: { type: "string", maxLength: 4096, description: "start: saved plan path under .pi/plans/ to run." },
				modelRef: { type: "string", maxLength: 512, description: "start: provider/model[:thinking]; default is the task's model, the mandate's worker model or the Desktop default." },
				kind: { type: "string", enum: [...SUPERVISOR_SEND_KINDS], description: "send: rework (counts against the rework limit), answer or note (default)." },
				outcome: { type: "string", enum: ["done", "failed"], description: "close: done (guarded) or failed." },
				summary: { type: "string", maxLength: MAX_SUPERVISOR_SUMMARY, description: "close: what was done or why it failed." },
			},
			required: ["op"],
			additionalProperties: false,
		},
		async execute(_id, params, signal, _update, ctx) {
			try {
				const request = parseSupervisorToolRequest(params);
				const host = (globalThis as Record<symbol, unknown>)[HOST];
				if (process.env.PI_SUBAGENT_AGENT_DIR || typeof host !== "function") {
					throw new Error("supervisor is available only in the Pix Desktop project supervisor session.");
				}
				const response = await (host as SupervisorHost)({ ...request, ownerSessionId: ctx.sessionManager.getSessionId() }, signal);
				return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: response };
			} catch (error) {
				const message = signal?.aborted ? "supervisor cancelled." : error instanceof Error ? error.message : "supervisor failed.";
				return { content: [{ type: "text" as const, text: message }], isError: true, details: { error: message } };
			}
		},
	});
}
