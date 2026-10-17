import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Pix session roots, resolved per collection so agent-dir changes apply. */
export function pixSessionsRoots(agentDir?: string): string[] {
	return [join(agentDir ?? getAgentDir(), "sessions")];
}
