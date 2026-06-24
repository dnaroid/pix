import * as fs from "node:fs";
import * as path from "node:path";

export function getRunRoot(cwd: string): string {
	return path.join(cwd, ".pi", "subagents");
}

export function createRunDir(cwd: string, slug?: string): string {
	if (slug) validateBasename(slug, "slug");
	const runRoot = getRunRoot(cwd);
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const baseName = `${timestamp}${slug ? `-${slug}` : ""}`;
	let runDir = path.join(runRoot, baseName);
	let suffix = 2;
	while (fs.existsSync(runDir)) {
		runDir = path.join(runRoot, `${baseName}-${suffix}`);
		suffix++;
	}
	fs.mkdirSync(path.join(runDir, "prompts"), { recursive: true });
	return runDir;
}

export function resolveRunDir(cwd: string, runDir: string): string {
	if (path.isAbsolute(runDir)) return runDir;
	return path.resolve(cwd, runDir);
}

export function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function hasLaunchedAgentPrompt(runDir: string, agentId: string): boolean {
	return fs.existsSync(path.join(runDir, agentId, "prompt.md"));
}

export function hasQueuedAgentPrompt(runDir: string, agentId: string): boolean {
	return fs.existsSync(path.join(runDir, "prompts", `${agentId}.md`));
}

export function hasAgentPrompt(runDir: string, agentId: string): boolean {
	return hasLaunchedAgentPrompt(runDir, agentId) || hasQueuedAgentPrompt(runDir, agentId);
}

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;

export function validateBasename(value: string, label: string): void {
	if (!SAFE_BASENAME.test(value)) {
		throw new Error(
			`Invalid ${label}: "${value}". Must match ${SAFE_BASENAME.source}`,
		);
	}
	if (value.includes("..")) {
		throw new Error(`Invalid ${label}: "${value}". Must not contain ".."`);
	}
}
