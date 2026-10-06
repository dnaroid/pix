import { RequestError } from "@agentclientprotocol/sdk";
import { parseBtwCommand, type BtwRequest } from "./contract.js";

export function parseDesktopBtwRequest(value: unknown): BtwRequest {
	if (!value || typeof value !== "object" || !("sessionId" in value)
		|| typeof value.sessionId !== "string" || !value.sessionId || value.sessionId.length > 512) {
		throw new RequestError(-32602, "BTW requires a session id");
	}
	try { return { ...parseBtwCommand(value), sessionId: value.sessionId }; }
	catch { throw new RequestError(-32602, "Invalid or oversized BTW command"); }
}
