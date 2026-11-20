import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { createId } from "../id.js";
import { logPixEvent } from "../logger.js";
import type { Entry } from "../types.js";

export type RuntimeDiagnosticPhase = "startup" | "replacement";

/**
 * Show the runtime's not-yet-reported diagnostics (startup or after a session
 * replacement) exactly once. The SDK deduplicates by type+message, so an
 * unchanged settings warning is not repeated on every /new, /resume or /fork.
 * Messages go to the transcript only; the shared log receives scalar metadata.
 */
export function reportRuntimeDiagnostics(
	runtime: AgentSessionRuntime,
	addEntry: (entry: Entry) => void,
	phase: RuntimeDiagnosticPhase,
	log: typeof logPixEvent = logPixEvent,
): void {
	let diagnostics: ReturnType<AgentSessionRuntime["takeUnreportedDiagnostics"]>;
	try {
		diagnostics = runtime.takeUnreportedDiagnostics?.() ?? [];
	} catch {
		return;
	}
	for (const diagnostic of diagnostics) {
		const kind = diagnostic.type === "error" ? "error" as const : "system" as const;
		addEntry({ id: createId("system"), kind, text: `[${diagnostic.type}] ${diagnostic.message}` });
		if (diagnostic.type !== "info") {
			log(diagnostic.type === "error" ? "error" : "warn", "session:runtime-diagnostic",
				{ diagnosticType: diagnostic.type, phase },
				{ project: runtime.cwd, sessionId: runtime.session?.sessionId, module: "session.lifecycle" });
		}
	}
}
