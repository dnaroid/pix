import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { RenderedLink } from "./file-links.js";

type SupportedEditor = "cursor" | "jetbrains" | "vscode" | "windsurf" | "zed";

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
	const filePath = link.filePath ?? filePathFromUrl(link.url);
	if (!filePath) return false;

	const editorLaunch = preferredEditorLaunch(filePath, link.line, link.column);
	if (editorLaunch && trySpawnCandidates(editorLaunch.candidates, editorLaunch.args)) return true;

	return openPathWithSystemViewer(filePath);
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

function gotoTarget(filePath: string, line: number | undefined, column: number | undefined): string {
	if (line === undefined) return filePath;
	return column === undefined ? `${filePath}:${line}` : `${filePath}:${line}:${column}`;
}

function preferredEditorLaunch(
	filePath: string,
	line: number | undefined,
	column: number | undefined,
): { args: string[]; candidates: string[] } | undefined {
	switch (detectEditor(deps.env)) {
		case "cursor":
			return { args: ["--goto", gotoTarget(filePath, line, column)], candidates: commandCandidates(deps.env.CURSOR_CLI, "cursor") };
		case "jetbrains":
			return {
				args: jetbrainsTargetArgs(filePath, line),
				candidates: commandCandidates(
					deps.env.JETBRAINS_IDE_CLI,
					"idea",
					"idea64",
					"webstorm",
					"webstorm64",
					"pycharm",
					"pycharm64",
					"goland",
					"goland64",
					"clion",
					"clion64",
					"phpstorm",
					"phpstorm64",
					"rubymine",
					"rubymine64",
					"rider",
					"rider64",
				),
			};
		case "vscode":
			return { args: ["--goto", gotoTarget(filePath, line, column)], candidates: commandCandidates(deps.env.VSCODE_CLI, "code", "code-insiders") };
		case "windsurf":
			return { args: ["--goto", gotoTarget(filePath, line, column)], candidates: commandCandidates(deps.env.WINDSURF_CLI, "windsurf") };
		case "zed":
			return { args: [zedTarget(filePath, line, column)], candidates: zedCommandCandidates() };
		default:
			return undefined;
	}
}

function detectEditor(env: NodeJS.ProcessEnv): SupportedEditor | undefined {
	const termProgram = env.TERM_PROGRAM?.trim().toLowerCase();
	const terminalEmulator = env.TERMINAL_EMULATOR?.trim().toLowerCase();
	const terminalProvider = env.TERMINAL_PROVIDER?.trim().toLowerCase();

	if (termProgram === "cursor" || env.CURSOR_TRACE_ID || env.CURSOR_TRACE) return "cursor";
	if (termProgram === "windsurf") return "windsurf";
	if (termProgram === "zed" || env.ZED_CLI) return "zed";
	if (termProgram === "vscode" || env.VSCODE_IPC_HOOK_CLI || env.VSCODE_GIT_IPC_HANDLE) return "vscode";
	if (terminalEmulator?.includes("jetbrains") || terminalProvider === "jetbrains") return "jetbrains";
	return undefined;
}

function zedCommandCandidates(): string[] {
	const candidates = [deps.env.ZED_CLI, "zed", "zeditor"];
	if (deps.platform === "darwin") candidates.push("/opt/homebrew/bin/zed", "/usr/local/bin/zed");
	return candidates.filter((candidate): candidate is string => Boolean(candidate));
}

function commandCandidates(primary: string | undefined, ...rest: string[]): string[] {
	return [primary, ...rest].filter((candidate): candidate is string => Boolean(candidate));
}

function jetbrainsTargetArgs(filePath: string, line: number | undefined): string[] {
	if (line === undefined) return [filePath];
	return ["--line", `${line}`, filePath];
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
