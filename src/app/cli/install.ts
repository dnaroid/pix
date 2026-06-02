import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	FONT_FAMILY_NAME,
	installJetBrainsNerdFont,
	isJetBrainsNerdFontInstalled,
} from "../terminal/nerd-font-controller.js";
import { clipboardInstallHint, clipboardSupportAvailable } from "../screen/clipboard.js";
import { getPixConfigPath } from "../../config.js";

export type PixInstallCliOptions = {
	checkOnly: boolean;
	help: boolean;
};

export type PixInstallCliContext = {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
};

export function formatPixInstallNextSteps(homeDir = homedir()): string {
	const pixConfigPath = getPixConfigPath(homeDir);
	const toolsConfigPath = join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");
	return [
		"",
		"Next steps:",
		`  1. Edit ${pixConfigPath} and set dictation.language / dictation.languages for voice input.`,
		`  2. Edit ${toolsConfigPath} and enable the LSP servers you use under lsp.servers.`,
		"  3. Start pix, then run /opencode-import to import opencode accounts.",
		"     For Antigravity accounts, run /antigravity-import or /antigravity-add-account.",
	].join("\n");
}

export function pixInstallUsage(): string {
	return `Usage: pix install [--check]
       pix setup [--check]

Check and install Pix runtime helpers for this user.

What it checks:
  - ${FONT_FAMILY_NAME} icon font for Pix glyphs
  - pi CLI availability, including Pix's bundled Pi dependency
  - Linux clipboard helpers / native clipboard fallback

Options:
  --check    Only report missing helpers, do not install
  -h, --help Show this help`;
}

export function parsePixInstallArgs(argv: readonly string[]): PixInstallCliOptions {
	let checkOnly = false;
	let help = false;

	for (const arg of argv) {
		if (arg === "--check") {
			checkOnly = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		throw new Error(`Unknown pix install argument: ${arg}\n\n${pixInstallUsage()}`);
	}

	return { checkOnly, help };
}

export async function runPixInstallCli(argv: readonly string[] = process.argv.slice(2), context: PixInstallCliContext = {}): Promise<number> {
	let options: PixInstallCliOptions;
	try {
		options = parsePixInstallArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	if (options.help) {
		console.log(pixInstallUsage());
		return 0;
	}

	const env = context.env ?? process.env;
	let failures = 0;

	console.log("Pix install checks");

	if (await isJetBrainsNerdFontInstalled()) {
		console.log(`✓ ${FONT_FAMILY_NAME} is installed`);
	} else if (options.checkOnly) {
		console.log(`! ${FONT_FAMILY_NAME} is missing`);
		failures += 1;
	} else {
		try {
			await installJetBrainsNerdFont();
			console.log(`✓ Installed ${FONT_FAMILY_NAME}`);
		} catch (error) {
			console.error(`✗ Failed to install ${FONT_FAMILY_NAME}: ${errorMessage(error)}`);
			failures += 1;
		}
	}

	const piCli = await resolvePiCliStatus(env);
	if (piCli.available) {
		console.log(`✓ pi CLI is available${piCli.detail ? ` (${piCli.detail})` : ""}`);
	} else if (options.checkOnly) {
		console.log("! pi CLI is missing");
		failures += 1;
	} else {
		try {
			await installPiCli();
			console.log("✓ Installed pi CLI globally");
		} catch (error) {
			console.error(`✗ Failed to install pi CLI: ${errorMessage(error)}`);
			console.error("  Pix can still use its bundled SDK, but sub-agent helpers may need `pi` on PATH.");
			failures += 1;
		}
	}

	if (await clipboardSupportAvailable(env)) {
		console.log("✓ Clipboard support is available");
	} else {
		console.log(`! Clipboard support is missing. ${clipboardInstallHint()}`);
		if (process.platform === "linux") failures += 1;
	}

	console.log(formatPixInstallNextSteps(context.homeDir));

	return failures === 0 ? 0 : 1;
}
async function resolvePiCliStatus(env: NodeJS.ProcessEnv): Promise<{ available: boolean; detail?: string }> {
	const bundledBin = env.PIX_BUNDLED_PI_BIN;
	if (bundledBin && (existsSync(join(bundledBin, process.platform === "win32" ? "pi.cmd" : "pi")) || existsSync(join(bundledBin, "pi")))) {
		return { available: true, detail: "bundled with Pix" };
	}
	if (commandExists("pi", env)) return { available: true, detail: "PATH" };
	return { available: false };
}

async function installPiCli(): Promise<void> {
	await runRequired("npm", ["install", "-g", "--ignore-scripts", "--min-release-age=0", "@earendil-works/pi-coding-agent"]);
}

function commandExists(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const pathValue = env.PATH ?? "";
	const dirs = pathValue.split(process.platform === "win32" ? ";" : ":").filter(Boolean);
	const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`] : [command];
	return dirs.some((dir) => names.some((name) => existsSync(join(dir, name))));
}

async function runRequired(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-800);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${command} exited with code ${code ?? "unknown"}`));
		});
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
