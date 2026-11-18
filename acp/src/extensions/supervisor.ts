import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUPERVISOR_OPS, SUPERVISOR_TOOL, parseSupervisorToolRequest } from "../acp/supervisor-contract.js";

/**
 * `supervisor` agent tool (decision 0077, phase 1: observer). ACP loads this
 * extension only into the project supervisor's runtime on Pix Desktop; worker,
 * headless and sub-agent runtimes never get it. Requests go to ACP through the
 * correlated bridge installed by `pi/supervisor-host.js`.
 */
const HOST = Symbol.for("pix.supervisor.request");

type SupervisorHost = (input: { ownerSessionId: string; op: string; sessionId?: string }, signal?: AbortSignal) => Promise<unknown>;

export default function supervisorExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUPERVISOR_TOOL,
		label: "Supervisor",
		description: "Project supervisor view of this project's work sessions (read-only in this phase). "
			+ "op=status: mandate, pause state and limits, managed sessions and the project's other recent sessions, each with linked task, "
			+ "run state (running, question, idle, not-loaded), last lifecycle event (settled with stop reason, question, error, stalled, checklist) and linked plan progress. "
			+ "op=read {sessionId}: bounded digest of one session — last user messages, final assistant report with stop reason, pending question, "
			+ "recent tool errors and files changed through write/edit. Never a full transcript.",
		promptSnippet: "Use supervisor to observe the project's work sessions: status for the overview, read for one session's digest.",
		promptGuidelines: [
			"supervisor: you are the project supervisor. In this phase you can only observe: report progress, finished work, questions, errors and stalls to the user; do not claim to start, steer or close sessions.",
			"supervisor read: judge finished work by the digest (final report, verification section, plan progress, tool errors) and tell the user whether it looks done or needs rework, with reasons.",
		],
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", enum: [...SUPERVISOR_OPS], description: "status (overview) or read (one session digest)." },
				sessionId: { type: "string", maxLength: 128, description: "read: session id from status." },
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
