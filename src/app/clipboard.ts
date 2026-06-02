import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function copyTextToClipboard(text: string): void {
	const commands = clipboardCommands();
	for (const [command, args] of commands) {
		const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
		if (!result.error && result.status === 0) return;
	}
	if (copyWithNativeClipboard(text)) return;
	throw new Error(`No clipboard command found. ${clipboardInstallHint()}`);
}


export function clipboardSupportAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	if (clipboardCommands().some(([command]) => commandExists(command, env))) return true;
	return resolveNativeClipboardEntrypoint() !== undefined;
}

export function clipboardInstallHint(): string {
	if (process.platform === "linux") {
		return "Install wl-clipboard for Wayland or xclip/xsel for X11 (for example: sudo apt install wl-clipboard xclip xsel).";
	}
	if (process.platform === "darwin") return "Install pbcopy or check macOS clipboard permissions.";
	if (process.platform === "win32") return "Install clip.exe or check Windows clipboard access.";
	return "Install a platform clipboard command.";
}


function clipboardCommands(): Array<[string, string[]]> {
	switch (process.platform) {
		case "darwin":
			return [["pbcopy", []]];
		case "win32":
			return [["clip.exe", []]];
		default:
			return [
				["wl-copy", []],
				["xclip", ["-selection", "clipboard"]],
				["xsel", ["--clipboard", "--input"]],
				["termux-clipboard-set", []],
			];
	}
}

function copyWithNativeClipboard(text: string): boolean {
	const entrypoint = resolveNativeClipboardEntrypoint();
	if (!entrypoint) return false;

	const script = `
		import { createRequire } from "node:module";
		import { readFileSync } from "node:fs";
		const require = createRequire(${JSON.stringify(import.meta.url)});
		const clipboard = require(${JSON.stringify(entrypoint)});
		await clipboard.setText(readFileSync(0, "utf8"));
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
		input: text,
		stdio: ["pipe", "ignore", "ignore"],
		timeout: 3_000,
	});
	return !result.error && result.status === 0;
}

function resolveNativeClipboardEntrypoint(): string | undefined {
	try {
		return require.resolve("@mariozechner/clipboard");
	} catch {
		return undefined;
	}
}

function commandExists(command: string, env: NodeJS.ProcessEnv): boolean {
	const names = process.platform === "win32" ? [command, command.replace(/\.exe$/iu, ".cmd"), command.replace(/\.exe$/iu, ".bat")] : [command];
	return names.some((name) => spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [name] : ["-lc", `command -v ${shellQuote(name)}`], { env, stdio: "ignore" }).status === 0);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
