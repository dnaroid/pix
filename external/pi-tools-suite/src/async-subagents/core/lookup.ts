// Run/agent lookup over the session-native store (replaces registry.json).
// `runDir` arguments accept a full run key or a bare batch name of the
// current parent scope; agent lookup without runDir picks the latest record.
import * as path from "node:path";
import { getRunRoot, parseRunKey, runKey, validateBasename } from "./paths.js";
import { findLatestAgentRecord, getRecord, hydrateFromManager, listRunRecords, listScopeRunDirs, resolveScope } from "./store.js";

export interface ScopeContext {
	cwd: string;
	sessionManager?: unknown;
}

/** Hydrate the parent session's records and return its scope. */
export function scopeForContext(ctx: ScopeContext): string {
	hydrateFromManager(ctx.sessionManager);
	return resolveScope(ctx.sessionManager);
}

/** Normalize a tool `runDir` (run key or batch name) to a run key of this scope. */
export function normalizeRunDir(cwd: string, scope: string, runDir: string): string {
	const resolved = path.isAbsolute(runDir) ? path.resolve(runDir) : undefined;
	if (resolved && parseRunKey(resolved)) return resolved;
	const batch = resolved ? path.basename(resolved) : runDir.trim();
	if (resolved && path.dirname(resolved) !== getRunRoot(cwd) && !parseRunKey(resolved)) {
		throw new Error(`Run not found: ${runDir}. Pass a batch name or a run key under ${getRunRoot(cwd)}/<scope>/.`);
	}
	validateBasename(batch, "runDir");
	return runKey(cwd, scope, batch);
}

export function resolveSubagentRunDir(ctx: ScopeContext, runDir?: string): string {
	const scope = scopeForContext(ctx);
	if (runDir) return normalizeRunDir(ctx.cwd, scope, runDir);
	const latest = listScopeRunDirs(ctx.cwd, scope)[0];
	if (!latest) throw new Error("runDir was omitted and this session has no sub-agent runs.");
	return latest;
}

export function resolveSubagentAgentRunDir(ctx: ScopeContext, agentId: string, runDir?: string): string {
	const scope = scopeForContext(ctx);
	if (runDir) return normalizeRunDir(ctx.cwd, scope, runDir);
	const record = findLatestAgentRecord(ctx.cwd, scope, agentId);
	if (!record) throw new Error(`runDir was omitted and agent "${agentId}" was not found in this session.`);
	return record.runDir;
}

/** True when the run key has at least one record (or the agent record when given). */
export function runKnown(runDir: string, agentId?: string): boolean {
	return agentId ? getRecord(runDir, agentId) !== undefined : listRunRecords(runDir).length > 0;
}
