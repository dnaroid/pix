import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TuiTabSnapshot {
	readonly sessionPaths: string[];
	readonly activeSessionPath?: string;
}

/** Read the project tab snapshot written by Pix TUI. Invalid state is non-fatal. */
export async function loadTuiTabSnapshot(cwd: string, agentDir = getAgentDir()): Promise<TuiTabSnapshot> {
	const projectPath = resolve(cwd);
	const key = createHash("sha256").update(projectPath).digest("hex").slice(0, 24);
	try {
		const parsed: unknown = JSON.parse(await readFile(join(agentDir, "pix", "tabs", `${key}.json`), "utf8"));
		if (
			!isRecord(parsed)
			|| (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4)
			|| !Array.isArray(parsed.tabs)
		) return { sessionPaths: [] };

		const sessionPaths: string[] = [];
		const seen = new Set<string>();
		for (const tab of parsed.tabs) {
			if (!isRecord(tab) || typeof tab.path !== "string") continue;
			const path = resolve(tab.path);
			if (seen.has(path)) continue;
			seen.add(path);
			sessionPaths.push(path);
		}

		const existingSessionPaths = (
			await Promise.all(sessionPaths.map(async (path) => await fileExists(path) ? path : undefined))
		).filter((path): path is string => path !== undefined);
		const activeSessionPath = typeof parsed.activePath === "string" ? resolve(parsed.activePath) : undefined;
		return activeSessionPath && existingSessionPaths.includes(activeSessionPath)
			? { sessionPaths: existingSessionPaths, activeSessionPath }
			: { sessionPaths: existingSessionPaths };
	} catch {
		return { sessionPaths: [] };
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
