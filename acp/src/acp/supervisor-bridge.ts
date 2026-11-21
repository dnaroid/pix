import { parseSupervisorToolRequest, type SupervisorToolRequest } from "./supervisor-contract.js";
import type { Logger } from "../logging.js";
import { parseSupervisorSetupRequest, type SupervisorSetupRequest } from "./supervisor-setup-contract.js";

type SupervisorResponse = { result?: unknown; error?: string };
type SupervisorSession = {
	acpSessionId: string;
	cwd: string;
	pi: { respondToSupervisor?: (requestId: string, response: SupervisorResponse) => Promise<void> };
};

/**
 * Answer one `supervisor` tool request of a physical runtime. A replaced
 * runtime never receives a reply (its request ids are random per runtime).
 */
export async function forwardSupervisorRequest(
	session: SupervisorSession,
	event: { requestId: string; request: unknown },
	handle: (cwd: string, callerSessionId: string, request: SupervisorToolRequest) => Promise<unknown>,
	current: () => boolean,
	logger: Logger,
	setup?: (request: SupervisorSetupRequest) => Promise<unknown>,
): Promise<void> {
	if (!session.pi.respondToSupervisor || !current()) return;
	let response: SupervisorResponse;
	try {
		const request = event.request && typeof event.request === "object" && !Array.isArray(event.request)
			? parseSupervisorSetupRequest(event.request as Record<string, unknown>) : undefined;
		if (request && !setup) throw new Error("Supervisor project setup is not available on this host");
		response = { result: request && setup ? await setup(request)
			: await handle(session.cwd, session.acpSessionId, parseSupervisorToolRequest(event.request)) };
	} catch (error) {
		const detail = error instanceof Error ? error.message : "Supervisor request failed";
		logger.warn(`supervisor request failed: ${detail.slice(0, 500)}`, { module: "supervisor" });
		response = { error: detail.slice(0, 2000) };
	}
	if (!current()) return;
	try { await session.pi.respondToSupervisor(event.requestId, response); }
	catch { logger.warn("supervisor reply delivery failed", { module: "supervisor" }); }
}
