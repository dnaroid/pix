import { spawnSync } from "node:child_process";

export function copyTextToClipboard(text: string): void {
	const commands = clipboardCommands();
	for (const [command, args] of commands) {
		const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
		if (!result.error && result.status === 0) return;
	}
	throw new Error("No clipboard command found");
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
			];
	}
}

