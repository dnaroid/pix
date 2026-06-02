import { createRequire } from "node:module";
import { commandExists, runProcess } from "../process.js";

const require = createRequire(import.meta.url);

export async function copyTextToClipboard(text: string): Promise<void> {
	const commands = clipboardCommands();
	for (const [command, args] of commands) {
		const result = await runProcess(command, args, { input: text, maxBufferBytes: 1024 });
		if (!result.error && result.status === 0) return;
	}
	if (await copyWithNativeClipboard(text)) return;
	if (copyWithOsc52(text)) return;
	throw new Error(`No clipboard command found. ${clipboardInstallHint()}`);
}


export async function clipboardSupportAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	for (const [command] of clipboardCommands()) {
		if (await commandExists(command, env)) return true;
	}
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

async function copyWithNativeClipboard(text: string): Promise<boolean> {
	const entrypoint = resolveNativeClipboardEntrypoint();
	if (!entrypoint) return false;

	const script = `
		import { createRequire } from "node:module";
		import { readFileSync } from "node:fs";
		const require = createRequire(${JSON.stringify(import.meta.url)});
		const clipboard = require(${JSON.stringify(entrypoint)});
		await clipboard.setText(readFileSync(0, "utf8"));
	`;
	const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
		input: text,
		timeoutMs: 3_000,
		maxBufferBytes: 1024,
	});
	return !result.error && result.status === 0;
}

function copyWithOsc52(text: string): boolean {
	if (process.stdout.destroyed || (!process.stdout.isTTY && !process.env.TMUX && !process.env.STY)) return false;

	process.stdout.write(osc52ClipboardSequence(text));
	return true;
}

export function osc52ClipboardSequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
	const sequence = `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
	if (env.TMUX) return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
	if (env.STY) return `\x1bP${sequence}\x1b\\`;
	return sequence;
}

function resolveNativeClipboardEntrypoint(): string | undefined {
	try {
		return require.resolve("@mariozechner/clipboard");
	} catch {
		return undefined;
	}
}
