import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderedLink } from "./file-links.js";

const MEDIA_EXTENSIONS = new Set([
	".3g2", ".3gp", ".aac", ".aiff", ".alac", ".apng", ".avi", ".avif", ".bmp", ".flac", ".gif", ".heic", ".heif",
	".ico", ".jpeg", ".jpg", ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".oga", ".ogg",
	".ogv", ".opus", ".png", ".svg", ".tif", ".tiff", ".wav", ".webm", ".webp", ".wma", ".wmv",
]);

type FileLinkOpenerDeps = {
	existsSync: typeof existsSync;
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	spawn: typeof spawn;
};

let deps: FileLinkOpenerDeps = { existsSync, env: process.env, platform: process.platform, spawn };

export function setFileLinkOpenerTestDeps(overrides: Partial<FileLinkOpenerDeps>): () => void {
	const previous = deps;
	deps = { ...deps, ...overrides };
	return () => {
		deps = previous;
	};
}

export function openFileLink(link: RenderedLink): boolean {
	if (isWebUrl(link.url)) return openPathWithSystemViewer(link.url);

	const filePath = link.filePath ?? filePathFromUrl(link.url);
	if (!filePath) return false;

	if (isZedTerminal(deps.env) && !isMediaFile(filePath)) {
		const openedInZed = trySpawnCandidates(zedCommandCandidates(), [zedTarget(filePath, link.line, link.column)]);
		if (openedInZed) return true;
	}

	return openPathWithSystemViewer(filePath);
}

function isWebUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://");
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

function isZedTerminal(env: NodeJS.ProcessEnv): boolean {
	return env.TERM_PROGRAM?.trim().toLowerCase() === "zed" || Boolean(env.ZED_CLI);
}

function isMediaFile(filePath: string): boolean {
	const pathApi = deps.platform === "win32" ? win32 : posix;
	return MEDIA_EXTENSIONS.has(pathApi.extname(filePath).toLowerCase());
}

function zedCommandCandidates(): string[] {
	const candidates = [deps.env.ZED_CLI, "zed", "zeditor"];
	if (deps.platform === "darwin") candidates.push("/opt/homebrew/bin/zed", "/usr/local/bin/zed");
	return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function trySpawnCandidates(candidates: readonly string[], args: readonly string[]): boolean {
	for (const command of candidates) {
		if (!canRunCommand(command)) continue;
		if (spawnDetached(command, args)) return true;
	}
	return false;
}

function canRunCommand(command: string): boolean {
	if (hasPathSeparator(command) || isAbsolute(command)) return deps.existsSync(command);
	return commandOnPath(command);
}

function hasPathSeparator(command: string): boolean {
	return command.includes("/") || command.includes("\\");
}

function commandOnPath(command: string): boolean {
	const pathEntries = deps.env.PATH?.split(pathDelimiter()) ?? [];
	const extensions = deps.platform === "win32"
		? (deps.env.PATHEXT?.split(";") ?? [".EXE", ".CMD", ".BAT", ".COM"])
		: [""];
	return pathEntries.some((entry) => pathCommandCandidates(entry, command, extensions).some((candidate) => deps.existsSync(candidate)));
}

function pathDelimiter(): string {
	return deps.platform === "win32" ? ";" : ":";
}

function pathCommandCandidates(entry: string, command: string, extensions: readonly string[]): string[] {
	const pathApi = deps.platform === "win32" ? win32 : posix;
	if (deps.platform !== "win32" || pathApi.extname(command)) return [pathApi.join(entry, command)];
	return [pathApi.join(entry, command), ...extensions.map((extension) => pathApi.join(entry, `${command}${extension}`))];
}

function openPathWithSystemViewer(filePath: string): boolean {
	if (deps.platform === "darwin") return spawnDetached("open", [filePath]);
	if (deps.platform === "win32") return spawnDetached("cmd", ["/c", "start", "", filePath]);
	return spawnDetached("xdg-open", [filePath]);
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
