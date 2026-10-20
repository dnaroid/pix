import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadPiToolsSuiteConfig } from "../config.js";
import { suiteDiagnostics } from "../lib/suite-diagnostics.js";
import { pruneHistoricalThinking } from "./prune.js";

/**
 * Experimental, opt-in via `pruneHistoricalThinking`. Runs in Pi's `context`
 * event, so it applies to every provider and changes only what is sent to the
 * model: the session file and the Desktop transcript keep all thinking.
 */
export default function historicalThinkingPrune(pi: ExtensionAPI): void {
	let lastConfigFailure = false;
	pi.on("context", async (event, ctx) => {
		let enabled: boolean;
		try {
			enabled = loadPiToolsSuiteConfig([], { cwd: ctx.cwd, ensureUserConfig: false }).pruneHistoricalThinking;
			lastConfigFailure = false;
		} catch {
			if (!lastConfigFailure) suiteDiagnostics.report("warn", "historical-thinking-prune", "config-read-failed", ctx.cwd);
			lastConfigFailure = true;
			return undefined;
		}
		if (!enabled) return undefined;
		const result = pruneHistoricalThinking(event.messages as any[]);
		return result.prunedBlocks > 0 ? { messages: result.messages as typeof event.messages } : undefined;
	});
}
