import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const DEFAULT_UPDATE_TIMEOUT_MS = 10_000;
const NPM_REGISTRY_URL = "https://registry.npmjs.org";

export type PixUpdateCliOptions = {
	checkOnly: boolean;
	force: boolean;
	help: boolean;
};

export type PixPackageInfo = {
	name: string;
	version: string;
	private: boolean;
	packageRoot: string;
};

export type PixUpdateStatus = "current" | "newer" | "unknown" | "skipped" | "unavailable";

export type PixUpdateCheckResult = {
	status: PixUpdateStatus;
	packageName: string;
	currentVersion: string;
	packageRoot: string;
	latestVersion?: string;
	reason?: string;
};

export type PixSelfUpdateCommand = {
	command: string;
	args: string[];
	display: string;
};

export type PixUpdateCheckOptions = {
	timeoutMs?: number;
	packageRoot?: string;
	fetchLatestVersion?: (packageName: string, currentVersion: string, timeoutMs: number) => Promise<string | undefined>;
};

export function pixUpdateUsage(): string {
	return `Usage: pix update [--check] [--force]

Check for or install the latest published Pix package.

Options:
  --check    Only check for an available update
  --force    Reinstall even when Pix appears up to date
  -h, --help Show this help

Inside the TUI, /update performs the same non-mutating check.
The bundled skills payload under skills/ is copied into ~/.agents/skills on startup.
The pi-tools-suite payload under external/pi-tools-suite is updated with Pix and linked into ~/.pi/agent/extensions on startup.`;
}

export function parsePixUpdateArgs(argv: readonly string[]): PixUpdateCliOptions {
	let checkOnly = false;
	let force = false;
	let help = false;

	for (const arg of argv) {
		if (arg === "--check") {
			checkOnly = true;
			continue;
		}
		if (arg === "--force") {
			force = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		throw new Error(`Unknown pix update argument: ${arg}\n\n${pixUpdateUsage()}`);
	}

	return { checkOnly, force, help };
}

export async function checkPixUpdate(options: PixUpdateCheckOptions = {}): Promise<PixUpdateCheckResult> {
	const packageInfo = readPixPackageInfo(options.packageRoot);
	const base = {
		packageName: packageInfo.name,
		currentVersion: packageInfo.version,
		packageRoot: packageInfo.packageRoot,
	};

	if (packageInfo.private) {
		return {
			...base,
			status: "unavailable",
			reason: "this checkout is marked private in package.json, so it cannot be updated from npm",
		};
	}

	const disabledReason = versionCheckDisabledReason();
	if (disabledReason) {
		return { ...base, status: "skipped", reason: disabledReason };
	}

	try {
		const latestVersion = await (options.fetchLatestVersion ?? fetchLatestNpmVersion)(
			packageInfo.name,
			packageInfo.version,
			options.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
		);
		if (!latestVersion) {
			return { ...base, status: "unknown", reason: "npm registry did not return a latest version" };
		}
		return {
			...base,
			status: isNewerPackageVersion(latestVersion, packageInfo.version) ? "newer" : "current",
			latestVersion,
		};
	} catch (error) {
		return {
			...base,
			status: "unknown",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

export function formatPixUpdateCheck(result: PixUpdateCheckResult): string {
	const lines = [
		"Pix update",
		`current: ${result.packageName} v${result.currentVersion}`,
		...(result.latestVersion ? [`latest: ${result.latestVersion}`] : []),
	];

	switch (result.status) {
		case "current":
			lines.push("status: up to date");
			break;
		case "newer":
			lines.push("status: update available");
			lines.push("run: pix update");
			lines.push("restart Pix after the command completes");
			break;
		case "skipped":
			lines.push(`status: check skipped (${result.reason ?? "disabled"})`);
			break;
		case "unavailable":
			lines.push(`status: update unavailable (${result.reason ?? "unsupported install"})`);
			lines.push(`source checkout: ${sourceCheckoutUpdateHint()}`);
			break;
		case "unknown":
			lines.push(`status: unable to check${result.reason ? ` (${result.reason})` : ""}`);
			lines.push("run: pix update --force to try reinstalling anyway");
			break;
	}

	lines.push("scope: Pix package, renderer extensions, bundled skills copied into ~/.agents/skills, and the pi-tools-suite payload linked into ~/.pi/agent/extensions");
	return lines.join("\n");
}

export function formatPixStartupUpdateDialog(result: PixUpdateCheckResult): string {
	const lines = [
		"A new Pix version is available.",
		`current: ${result.packageName} v${result.currentVersion}`,
		...(result.latestVersion ? [`latest: ${result.latestVersion}`] : []),
		"",
		"To update:",
		"1. Exit Pix.",
		"2. Run `pix update` in your shell.",
		"3. Start Pix again after the update completes.",
	];
	return lines.join("\n");
}

export function getPixSelfUpdateCommand(packageName: string, latestVersion?: string, packageRoot = readPixPackageInfo().packageRoot): PixSelfUpdateCommand | undefined {
	if (!packageRootLooksPackageManaged(packageRoot)) return undefined;

	const installSpec = latestVersion ? `${packageName}@${latestVersion}` : packageName;
	const method = detectInstallMethod(packageRoot);
	const commandParts = method === "npm" ? configuredNpmCommand() ?? ["npm"] : undefined;

	switch (method) {
		case "npm": {
			const [command = "npm", ...npmArgs] = commandParts ?? ["npm"];
			return makeCommand(command, [...npmArgs, "install", "-g", "--ignore-scripts", "--min-release-age=0", installSpec]);
		}
		case "pnpm":
			return makeCommand("pnpm", ["install", "-g", "--ignore-scripts", "--config.minimumReleaseAge=0", installSpec]);
		case "yarn":
			return makeCommand("yarn", ["global", "add", "--ignore-scripts", installSpec]);
		case "bun":
			return makeCommand("bun", ["install", "-g", "--ignore-scripts", "--minimum-release-age=0", installSpec]);
		case "source":
			return undefined;
	}
}

export async function runPixUpdateCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	let options: PixUpdateCliOptions;
	try {
		options = parsePixUpdateArgs(argv);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}

	if (options.help) {
		console.log(pixUpdateUsage());
		return 0;
	}

	const check = await checkPixUpdate();
	console.log(formatPixUpdateCheck(check));

	if (options.checkOnly) return check.status === "unavailable" ? 1 : 0;
	if (check.status === "current" && !options.force) return 0;
	if ((check.status === "skipped" || check.status === "unavailable") && !options.force) return 1;

	const command = getPixSelfUpdateCommand(check.packageName, check.latestVersion);
	if (!command) {
		console.error(`pix cannot self-update this installation. ${sourceCheckoutUpdateHint()}`);
		return 1;
	}

	console.log(`Updating Pix with ${command.display}...`);
	try {
		await runCommand(command);
		console.log("Updated Pix. Restart any running pix sessions.");
		return 0;
	} catch (error) {
		console.error(`Pix update failed: ${error instanceof Error ? error.message : String(error)}`);
		console.error(`Try running manually: ${command.display}`);
		return 1;
	}
}

type InstallMethod = "npm" | "pnpm" | "yarn" | "bun" | "source";

function readPixPackageInfo(packageRoot = findPixPackageRoot()): PixPackageInfo {
	const packageJsonPath = join(packageRoot, "package.json");
	const raw = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
	const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "pi-ui-extend";
	const version = typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : "0.0.0";
	return {
		name,
		version,
		private: raw.private === true,
		packageRoot,
	};
}

function findPixPackageRoot(): string {
	let currentDir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const packageJsonPath = join(currentDir, "package.json");
		if (existsSync(packageJsonPath)) return currentDir;
		const nextDir = dirname(currentDir);
		if (nextDir === currentDir) throw new Error("Could not find pix package.json");
		currentDir = nextDir;
	}
}

async function fetchLatestNpmVersion(packageName: string, currentVersion: string, timeoutMs: number): Promise<string | undefined> {
	const response = await fetch(`${NPM_REGISTRY_URL}/${encodeURIComponent(packageName)}/latest`, {
		headers: {
			accept: "application/json",
			"User-Agent": `pix/${currentVersion}`,
		},
		signal: AbortSignal.timeout(timeoutMs),
	});

	if (response.status === 404) return undefined;
	if (!response.ok) throw new Error(`npm registry returned ${response.status}`);

	const data = await response.json() as Record<string, unknown>;
	return typeof data.version === "string" && data.version.trim() ? data.version.trim() : undefined;
}

function versionCheckDisabledReason(): string | undefined {
	if (truthyEnv(process.env.PI_OFFLINE)) return "PI_OFFLINE is set";
	if (truthyEnv(process.env.PI_SKIP_VERSION_CHECK)) return "PI_SKIP_VERSION_CHECK is set";
	if (truthyEnv(process.env.PIX_SKIP_VERSION_CHECK)) return "PIX_SKIP_VERSION_CHECK is set";
	return undefined;
}

function truthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function packageRootLooksPackageManaged(packageRoot: string): boolean {
	return normalizePath(packageRoot).includes("/node_modules/");
}

function detectInstallMethod(packageRoot: string): InstallMethod {
	const normalized = normalizePath(`${packageRoot}\0${process.execPath || ""}`);
	if (!packageRootLooksPackageManaged(packageRoot)) return "source";
	if (normalized.includes("/.pnpm/") || normalized.includes("/pnpm/")) return "pnpm";
	if (normalized.includes("/.yarn/") || normalized.includes("/yarn/")) return "yarn";
	if (process.versions.bun || normalized.includes("/.bun/") || normalized.includes("/install/global/node_modules/")) return "bun";
	return "npm";
}

function configuredNpmCommand(): string[] | undefined {
	try {
		return SettingsManager.create(process.cwd(), getAgentDir()).getNpmCommand();
	} catch {
		return undefined;
	}
}

function makeCommand(command: string, args: string[]): PixSelfUpdateCommand {
	return {
		command,
		args,
		display: [command, ...args].map(shellDisplayQuote).join(" "),
	};
}

function shellDisplayQuote(value: string): string {
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
	return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function normalizePath(pathValue: string): string {
	return resolve(pathValue).toLowerCase().replace(/\\/g, "/");
}

function sourceCheckoutUpdateHint(): string {
	return "from a source checkout, run `git pull && npm install --ignore-scripts && npm run build:pix && npm run link:pix`";
}

function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) return comparison > 0;
	return candidateVersion.trim() !== currentVersion.trim();
}

function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = parsePackageVersion(leftVersion);
	const right = parsePackageVersion(rightVersion);
	if (!left || !right) return undefined;
	if (left.major !== right.major) return left.major - right.major;
	if (left.minor !== right.minor) return left.minor - right.minor;
	if (left.patch !== right.patch) return left.patch - right.patch;
	if (left.prerelease === right.prerelease) return 0;
	if (!left.prerelease) return 1;
	if (!right.prerelease) return -1;
	return left.prerelease.localeCompare(right.prerelease);
}

function parsePackageVersion(version: string): { major: number; minor: number; patch: number; prerelease?: string } | undefined {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u);
	if (!match) return undefined;
	return {
		major: Number.parseInt(match[1] ?? "0", 10),
		minor: Number.parseInt(match[2] ?? "0", 10),
		patch: Number.parseInt(match[3] ?? "0", 10),
		...(match[4] === undefined ? {} : { prerelease: match[4] }),
	};
}

async function runCommand(command: PixSelfUpdateCommand): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(command.command, command.args, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolvePromise();
			} else if (signal) {
				reject(new Error(`${command.display} terminated by signal ${signal}`));
			} else {
				reject(new Error(`${command.display} exited with code ${code ?? "unknown"}`));
			}
		});
	});
}
