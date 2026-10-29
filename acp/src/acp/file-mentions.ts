import { RequestError } from "@agentclientprotocol/sdk";
import { isAbsolute } from "node:path";
export { FileMentionIndex } from "../../../dist/file-mention-index.js";

export function parseFileMentionsRequest(value: unknown): { cwd: string; query: string } {
	if (!value || typeof value !== "object" || !("cwd" in value) || !("query" in value)
		|| typeof value.cwd !== "string" || !isAbsolute(value.cwd) || typeof value.query !== "string" || value.query.length > 256) {
		throw new RequestError(-32602, "pix/files/complete requires absolute cwd and query (up to 256 characters)");
	}
	return { cwd: value.cwd, query: value.query };
}
