import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../../context-usage.js";

/** Parent → child launch metadata, JSON-encoded (decision 0072). */
export const SUBAGENT_META_ENV = "PI_SUBAGENT_META";
/** Custom entry type carrying the child's authoritative lineage and launch facts. */
export const SUBAGENT_META_ENTRY = "subagent_meta";

export interface SubagentMeta {
	version: 1;
	agentId: string;
	/** Batch label; currently the run directory basename. */
	batch: string;
	runDir: string;
	cwd: string;
	subagentType?: string;
	parentSession?: string;
	parentSessionId?: string;
	/** Parent scope (session id, or a per-process scope for a headless parent). */
	scope?: string;
}

export function parseSubagentMeta(raw: string | undefined): SubagentMeta | undefined {
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<SubagentMeta> | null;
		if (!value || value.version !== 1 || typeof value.agentId !== "string" || typeof value.runDir !== "string"
			|| typeof value.batch !== "string" || typeof value.cwd !== "string") return undefined;
		return value as SubagentMeta;
	} catch {
		return undefined;
	}
}

type EntryReader = { getEntries?: () => ReadonlyArray<{ type?: string; customType?: string }> };

/**
 * Child-side writer: appends one `subagent_meta` entry per session at
 * session_start. The SDK flushes it lazily with the first user message, and a
 * resumed session that already has the entry is left untouched. The child is
 * the only writer of its JSONL.
 */
export function registerSubagentMetaEntry(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	const meta = parseSubagentMeta(env[SUBAGENT_META_ENV]);
	if (!meta) return;
	pi.on("session_start", (_event, ctx) => {
		try {
			const entries = (ctx.sessionManager as EntryReader).getEntries?.() ?? [];
			if (entries.some((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_ENTRY)) return;
			pi.appendEntry(SUBAGENT_META_ENTRY, meta);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	});
}
