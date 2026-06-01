import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type NerdFontInstallHost = {
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

const CASK_NAME = "font-jetbrains-mono-nerd-font";
const FONT_FILE_PATTERN = /(?:JetBrainsMono|JetBrains).*Nerd.*\.(?:ttf|otf)$/iu;

export class NerdFontController {
	private ensureStarted = false;

	constructor(private readonly host: NerdFontInstallHost) {}

	ensureInstalledOnStartup(): void {
		if (this.ensureStarted) return;
		this.ensureStarted = true;

		void this.ensureInstalled();
	}

	private async ensureInstalled(): Promise<void> {
		if (await isJetBrainsNerdFontInstalled()) return;

		if (process.platform !== "darwin") {
			this.host.showToast("Nerd Font is missing; auto-install is only configured for macOS Homebrew", "warning");
			return;
		}

		if (!commandExists("brew")) {
			this.host.showToast("Nerd Font is missing; install Homebrew or JetBrainsMono Nerd Font manually", "warning");
			return;
		}

		this.host.showToast("Installing JetBrainsMono Nerd Font…", "info");
		try {
			await runBrewInstall();
			if (await isJetBrainsNerdFontInstalled()) {
				this.host.showToast("JetBrainsMono Nerd Font installed", "success");
			} else {
				this.host.showToast("Nerd Font install finished, but the font was not detected", "warning");
			}
		} catch (error) {
			this.host.showToast(`Nerd Font install failed: ${errorMessage(error)}`, "error");
		} finally {
			this.host.render();
		}
	}
}

async function isJetBrainsNerdFontInstalled(): Promise<boolean> {
	if (commandExists("brew") && spawnSync("brew", ["list", "--cask", CASK_NAME], { stdio: "ignore" }).status === 0) return true;

	const fontDirs = [join(homedir(), "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
	for (const dir of fontDirs) {
		try {
			const files = await readdir(dir);
			if (files.some((file) => FONT_FILE_PATTERN.test(file))) return true;
		} catch {
			// Ignore unreadable/missing font directories.
		}
	}

	return false;
}

async function runBrewInstall(): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("brew", ["install", "--cask", CASK_NAME], {
			env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-800);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `brew exited with code ${code ?? "unknown"}`));
		});
	});
}

function commandExists(command: string): boolean {
	if (process.platform === "win32") return spawnSync("where", [command], { stdio: "ignore" }).status === 0;
	return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
