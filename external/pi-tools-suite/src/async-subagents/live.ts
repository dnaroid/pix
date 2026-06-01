import type { LiveAgent } from "./types.js";

export function getLiveRun(liveAgents: Map<string, Map<string, LiveAgent>>, runDir: string): Map<string, LiveAgent> {
	let run = liveAgents.get(runDir);
	if (!run) {
		run = new Map();
		liveAgents.set(runDir, run);
	}
	return run;
}
