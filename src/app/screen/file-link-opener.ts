import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderedLink } from "./file-links.js";

type FileLinkOpenerDeps = {
	existsSync: typeof existsSync;
	spawn: typeof spawn;
};

let deps: FileLinkOpenerDeps = { existsSync, spawn };

export function setFileLinkOpenerTestDeps(overrides: Partial<FileLinkOpenerDeps>): () => void {
	const previous = deps;
	deps = { ...deps, ...overrides };
	return () => {
		deps = previous;
	};
}

export function openFileLink(link: RenderedLink): boolean {
	const filePath = link.filePath ?? filePathFromUrl(link.url);
	if (!filePath) return false;

	const target = zedTarget(filePath, link.line, link.column);
	const candidates = zedCommandCandidates();
	if (trySpawnCandidates(candidates, [target])) return true;

	if (process.platform === "darwin") return spawnDetached("open", ["-a", "Zed", filePath]);
	return false;
}

function filePathFromUrl(url: string): string | undefined {
	if (!url.startsWith("file://")) return undefined;
	try {
		return fileURLToPath(url);
	} catch {
		return undefined;
	}
}

function zedTarget(filePath: string, line: number | undefined, column: number | undefined): string {
	if (line === undefined) return filePath;
	return column === undefined ? `${filePath}:${line}` : `${filePath}:${line}:${column}`;
}

function zedCommandCandidates(): string[] {
	const candidates = [process.env.ZED_CLI, "zed", "zeditor"];
	if (process.platform === "darwin") candidates.push("/opt/homebrew/bin/zed", "/usr/local/bin/zed");
	return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function trySpawnCandidates(candidates: readonly string[], args: readonly string[]): boolean {
	for (const command of candidates) {
		if (command.includes("/") && !deps.existsSync(command)) continue;
		if (!command.includes("/") && !commandOnPath(command)) continue;
		if (spawnDetached(command, args)) return true;
	}
	return false;
}

function commandOnPath(command: string): boolean {
	const pathEntries = process.env.PATH?.split(delimiter) ?? [];
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT?.split(";") ?? [".EXE", ".CMD", ".BAT", ".COM"])
		: [""];
	return pathEntries.some((entry) => extensions.some((extension) => deps.existsSync(join(entry, `${command}${extension}`))));
}

function spawnDetached(command: string, args: readonly string[]): boolean {
	try {
		const child = deps.spawn(command, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
