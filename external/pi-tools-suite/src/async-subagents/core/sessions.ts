import * as fs from "node:fs";
import * as path from "node:path";
import { hasLaunchedAgentPrompt, isDir } from "./paths.js";
import { listSubagentRunDirs } from "./registry.js";
import { getAgentState } from "./state.js";
import type { AgentState } from "./types.js";

export const SUBAGENT_SESSION_FILE = "session_file";
export const SUBAGENT_PARENT_SESSION_FILE = "parent_session";
export const SUBAGENT_RETURN_SESSION_FILE = "return_session";

export interface SubagentSessionRecord {
	runDir: string;
	runName: string;
	agentDir: string;
	agentId: string;
	sessionFile?: string;
	parentSession?: string;
	returnSession?: string;
	state: AgentState | null;
}

export function getAgentSessionDir(agentDir: string): string {
	return path.join(agentDir, "sessions");
}

export function writeSessionFileLink(agentDir: string, sessionFile: string | undefined): void {
	const value = sessionFile?.trim();
	if (!value) return;
	fs.writeFileSync(path.join(agentDir, SUBAGENT_SESSION_FILE), value, "utf-8");
}

export function writeParentSessionLink(agentDir: string, parentSession: string | undefined): void {
	const value = parentSession?.trim();
	if (!value) return;
	fs.writeFileSync(path.join(agentDir, SUBAGENT_PARENT_SESSION_FILE), value, "utf-8");
}

export function writeReturnSessionLink(agentDir: string, returnSession: string | undefined): void {
	const value = returnSession?.trim();
	if (!value) return;
	fs.writeFileSync(path.join(agentDir, SUBAGENT_RETURN_SESSION_FILE), value, "utf-8");
}

export function readTextFile(filePath: string): string | undefined {
	try {
		const value = fs.readFileSync(filePath, "utf-8").trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

export function readSessionFileLink(agentDir: string): string | undefined {
	return readTextFile(path.join(agentDir, SUBAGENT_SESSION_FILE));
}

export function readParentSessionLink(agentDir: string): string | undefined {
	return readTextFile(path.join(agentDir, SUBAGENT_PARENT_SESSION_FILE));
}

export function readReturnSessionLink(agentDir: string): string | undefined {
	return readTextFile(path.join(agentDir, SUBAGENT_RETURN_SESSION_FILE));
}

export function findLatestSessionFile(sessionDir: string): string | undefined {
	if (!isDir(sessionDir)) return undefined;
	const files: string[] = [];
	collectJsonlFiles(sessionDir, files);
	files.sort((a, b) => statMtimeMs(b) - statMtimeMs(a));
	return files[0];
}

function collectJsonlFiles(dir: string, out: string[]): void {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) collectJsonlFiles(fullPath, out);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(fullPath);
	}
}

function statMtimeMs(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

export function ensureSessionFileLink(agentDir: string): string | undefined {
	const linked = readSessionFileLink(agentDir);
	if (linked && fs.existsSync(linked)) return linked;
	const latest = findLatestSessionFile(getAgentSessionDir(agentDir));
	if (latest) writeSessionFileLink(agentDir, latest);
	return latest ?? linked;
}

export function listRunDirs(cwd: string): string[] {
	return listSubagentRunDirs(cwd);
}

export function listSubagentSessionRecords(cwd: string): SubagentSessionRecord[] {
	const records: SubagentSessionRecord[] = [];
	for (const runDir of listRunDirs(cwd)) {
		for (const entry of fs.readdirSync(runDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const agentDir = path.join(runDir, entry.name);
			if (!hasLaunchedAgentPrompt(runDir, entry.name)) continue;
			records.push({
				runDir,
				runName: path.basename(runDir),
				agentDir,
				agentId: entry.name,
				sessionFile: ensureSessionFileLink(agentDir),
				parentSession: readParentSessionLink(agentDir),
				returnSession: readReturnSessionLink(agentDir),
				state: getAgentState(runDir, entry.name),
			});
		}
	}
	return records;
}

export function findSubagentSessionByFile(cwd: string, sessionFile: string | undefined): SubagentSessionRecord | undefined {
	if (!sessionFile) return undefined;
	const normalized = normalizePath(sessionFile);
	return listSubagentSessionRecords(cwd).find((record) => normalizePath(record.sessionFile) === normalized);
}

function normalizePath(filePath: string | undefined): string | undefined {
	if (!filePath) return undefined;
	const resolved = path.resolve(filePath);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}
