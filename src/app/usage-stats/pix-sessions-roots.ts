import { join } from "node:path";

/** Pix session roots, resolved per collection so agent-dir changes apply. */
export function pixSessionsRoots(agentDir: string): string[] {
	return [join(agentDir, "sessions")];
}
