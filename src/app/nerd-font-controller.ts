import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type NerdFontInstallHost = {
	showToast(message: string, kind: "success" | "error" | "warning" | "info"): void;
	render(): void;
};

const CASK_NAME = "font-jetbrains-mono-nerd-font";
export const FONT_FAMILY_NAME = "JetBrainsMono Nerd Font Mono";
export const FONT_FILE_NAME = "JetBrainsMonoNerdFontMono-Regular.ttf";
export const FONT_DOWNLOAD_URL = "https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/patched-fonts/JetBrainsMono/Ligatures/Regular/JetBrainsMonoNerdFontMono-Regular.ttf";
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

		this.host.showToast("Installing JetBrainsMono Nerd Font…", "info");
		try {
			await installJetBrainsNerdFont();
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

export async function isJetBrainsNerdFontInstalled(): Promise<boolean> {
	if (commandExists("brew") && spawnSync("brew", ["list", "--cask", CASK_NAME], { stdio: "ignore" }).status === 0) return true;
	if (process.platform === "linux" && commandExists("fc-match")) {
		const result = spawnSync("fc-match", ["-f", "%{family}", FONT_FAMILY_NAME], { encoding: "utf8" });
		if (result.status === 0 && /JetBrains.*Nerd/iu.test(result.stdout)) return true;
	}

	const fontDirs = platformFontDirs();
	for (const dir of fontDirs) {
		if (await directoryContainsFont(dir)) return true;
	}

	return false;
}

export async function installJetBrainsNerdFont(): Promise<string> {
	if (process.platform === "darwin" && commandExists("brew")) {
		await runBrewInstall();
		return CASK_NAME;
	}

	const targetPath = userFontInstallPath();
	await mkdir(dirname(targetPath), { recursive: true });
	const response = await fetch(FONT_DOWNLOAD_URL, {
		headers: { "User-Agent": "pix-font-installer" },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length < 100_000) throw new Error("downloaded font is unexpectedly small");
	await writeFile(targetPath, bytes);

	if (process.platform === "linux") runOptionalCommand("fc-cache", ["-f", dirname(targetPath)]);
	if (process.platform === "win32") registerWindowsUserFont(targetPath);

	return targetPath;
}

export function userFontInstallPath(): string {
	switch (process.platform) {
		case "darwin":
			return join(homedir(), "Library", "Fonts", FONT_FILE_NAME);
		case "win32":
			return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts", FONT_FILE_NAME);
		default:
			return join(homedir(), ".local", "share", "fonts", "pix", FONT_FILE_NAME);
	}
}

function platformFontDirs(): string[] {
	switch (process.platform) {
		case "darwin":
			return [join(homedir(), "Library", "Fonts"), "/Library/Fonts", "/System/Library/Fonts"];
		case "win32":
			return [
				join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
				join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
			];
		default:
			return [join(homedir(), ".local", "share", "fonts"), join(homedir(), ".fonts"), "/usr/local/share/fonts", "/usr/share/fonts"];
	}
}

async function directoryContainsFont(root: string): Promise<boolean> {
	if (!existsSync(root)) return false;
	const pending = [{ dir: root, depth: 0 }];
	let scanned = 0;
	while (pending.length > 0 && scanned < 5_000) {
		const current = pending.pop();
		if (!current) continue;
		let entries;
		try {
			entries = await readdir(current.dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			scanned += 1;
			if (entry.isFile() && FONT_FILE_PATTERN.test(entry.name)) return true;
			if (entry.isDirectory() && current.depth < 4) pending.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
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

function registerWindowsUserFont(fontPath: string): void {
	const escapedPath = fontPath.replaceAll("'", "''");
	const escapedName = `${FONT_FAMILY_NAME} (TrueType)`.replaceAll("'", "''");
	runOptionalCommand("powershell.exe", [
		"-NoProfile",
		"-ExecutionPolicy",
		"Bypass",
		"-Command",
		`New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Force | Out-Null; New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts' -Name '${escapedName}' -Value '${escapedPath}' -PropertyType String -Force | Out-Null`,
	]);
}

function runOptionalCommand(command: string, args: string[]): void {
	spawnSync(command, args, { stdio: "ignore" });
}

function commandExists(command: string): boolean {
	if (process.platform === "win32") return spawnSync("where", [command], { stdio: "ignore" }).status === 0;
	return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
