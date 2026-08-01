import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants as fsConstants } from "node:fs";

import type { AgentSessionRuntime, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const PI_CLI_COMMAND = "pi";
const PI_TOOLS_SUITE_EXTENSION_ID = "pi-tools-suite";
const IDX_CLI_COMMAND = "idx";
const IDX_SPAWN_COMMAND = process.platform === "win32" ? "idx.cmd" : IDX_CLI_COMMAND;
const IDX_UPDATE_TIMEOUT_MS = 600_000;
const MAX_IDX_UPDATE_OUTPUT_BYTES = 32_000;

export type StartupAvailabilityIssue = {
	kind: "warning" | "error";
	message: string;
};

export type IdxStartupUpdateStatus = "current" | "updated" | "checked" | "skipped" | "unavailable" | "failed";

export type IdxStartupUpdateResult = {
	status: IdxStartupUpdateStatus;
	previousVersion?: string;
	currentVersion?: string;
	reason?: string;
};

type IdxUpdateCommandResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
};

export type IdxStartupUpdateOptions = {
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	runUpdate?: (timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<IdxUpdateCommandResult>;
};

export async function collectStartupAvailabilityIssues(runtime: AgentSessionRuntime): Promise<StartupAvailabilityIssue[]> {
	return [
		...(await checkPiCliAvailability()),
		...checkPiToolsSuiteExtensionAvailability(runtime.services.resourceLoader.getExtensions()),
		...checkSelectedModelAuthAvailability(runtime),
	];
}

export function checkSelectedModelAuthAvailability(runtime: AgentSessionRuntime): StartupAvailabilityIssue[] {
	const model = runtime.session.model;
	if (!model) {
		return [{
			kind: "error",
			message: "No model is selected. Configure a provider with `npx @earendil-works/pi-coding-agent` and /login (or run /opencode-import), then choose /model in Pix.",
		}];
	}

	if (runtime.services.modelRuntime.getProviderAuthStatus(model.provider).configured) return [];
	return [{
		kind: "error",
		message: `Selected model ${model.provider}/${model.id} has no configured credentials. Use \`npx @earendil-works/pi-coding-agent\` and /login, or run /opencode-import for supported OpenCode accounts, then choose /model.`,
	}];
}

export async function checkPiCliAvailability(pathValue = process.env.PATH ?? ""): Promise<StartupAvailabilityIssue[]> {
	if (await executableExistsOnPath(PI_CLI_COMMAND, pathValue)) return [];

	return [{
		kind: "error",
		message: "pi CLI is not available on PATH. Run `pix install` or add pi to PATH before starting pix.",
	}];
}

export async function checkAndUpdateIdxOnStartup(options: IdxStartupUpdateOptions = {}): Promise<IdxStartupUpdateResult> {
	const env = options.env ?? process.env;
	const disabledReason = startupVersionCheckDisabledReason(env);
	if (disabledReason) return { status: "skipped", reason: disabledReason };
	if (!options.runUpdate && !(await executableExistsOnPath(IDX_CLI_COMMAND, env.PATH ?? ""))) {
		return { status: "unavailable" };
	}

	let commandResult: IdxUpdateCommandResult;
	try {
		commandResult = await (options.runUpdate ?? runIdxUpdate)(options.timeoutMs ?? IDX_UPDATE_TIMEOUT_MS, env);
	} catch (error) {
		if (isCommandNotFoundError(error)) {
			return { status: "unavailable" };
		}
		return { status: "failed", reason: errorMessage(error) };
	}

	const output = [commandResult.stdout, commandResult.stderr].filter(Boolean).join("\n").trim();
	if (commandResult.timedOut) {
		return { status: "failed", reason: compactCommandFailure("idx update timed out", output) };
	}
	if (commandResult.code !== 0) {
		const termination = commandResult.signal
			? `idx update terminated by signal ${commandResult.signal}`
			: `idx update exited with code ${commandResult.code ?? "unknown"}`;
		return { status: "failed", reason: compactCommandFailure(termination, output) };
	}

	const updatedVersions = parseUpdatedIdxVersions(output);
	if (updatedVersions) return { status: "updated", ...updatedVersions };

	const currentVersion = parseCurrentIdxVersion(output);
	if (currentVersion) return { status: "current", currentVersion };
	return { status: "checked" };
}

export function formatIdxStartupUpdateNotice(result: IdxStartupUpdateResult): string | undefined {
	switch (result.status) {
		case "updated": {
			if (!result.currentVersion) return "idx was updated to the latest version.";
			const previousVersion = result.previousVersion ? ` from ${result.previousVersion}` : "";
			return `idx updated${previousVersion} to ${result.currentVersion}.`;
		}
		case "unavailable":
			return undefined;
		case "failed":
			return `idx startup update failed: ${result.reason ?? "unknown error"}`;
		case "current":
		case "checked":
		case "skipped":
			return undefined;
	}
}

export function checkPiToolsSuiteExtensionAvailability(extensionsResult: LoadExtensionsResult): StartupAvailabilityIssue[] {
	if (extensionsResult.extensions.some(isPiToolsSuiteExtension)) return [];

	const matchingErrors = extensionsResult.errors.filter((error) => pathLooksLikePiToolsSuite(error.path));
	if (matchingErrors.length > 0) {
		return matchingErrors.map((error) => ({
			kind: "error" as const,
			message: `Pix bundled pi-tools-suite failed to load: ${error.error}. Check write access to ~/.pi/agent/extensions and the bundled external/pi-tools-suite payload.`,
		}));
	}

	return [{
		kind: "error",
		message: "Pix bundled pi-tools-suite is not loaded from ~/.pi/agent/extensions/pi-tools-suite. Check write access to ~/.pi/agent/extensions and the bundled external/pi-tools-suite payload.",
	}];
}

async function executableExistsOnPath(command: string, pathValue: string): Promise<boolean> {
	const dirs = pathValue.split(delimiter).filter((part) => part.length > 0);
	const names = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`] : [command];
	for (const dir of dirs) {
		for (const name of names) {
			try {
				await access(join(dir, name), fsConstants.X_OK);
				return true;
			} catch {
				// Keep scanning PATH entries.
			}
		}
	}
	return false;
}

async function runIdxUpdate(timeoutMs: number, env: NodeJS.ProcessEnv): Promise<IdxUpdateCommandResult> {
	return await new Promise<IdxUpdateCommandResult>((resolve, reject) => {
		const child = spawn(IDX_SPAWN_COMMAND, ["update"], {
			env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		timer.unref();

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBoundedOutput(stdout, chunk.toString());
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBoundedOutput(stderr, chunk.toString());
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, signal, stdout, stderr, ...(timedOut ? { timedOut: true } : {}) });
		});
	});
}

function appendBoundedOutput(existing: string, addition: string): string {
	const combined = `${existing}${addition}`;
	if (Buffer.byteLength(combined, "utf8") <= MAX_IDX_UPDATE_OUTPUT_BYTES) return combined;
	return Buffer.from(combined, "utf8").subarray(-MAX_IDX_UPDATE_OUTPUT_BYTES).toString("utf8").replace(/^\uFFFD/u, "");
}

function parseUpdatedIdxVersions(output: string): Pick<IdxStartupUpdateResult, "previousVersion" | "currentVersion"> | undefined {
	const match = output.match(/(?:Updating|Updated) indexer-cli\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*(?:→|->)\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/iu);
	const previousVersion = match?.[1];
	const currentVersion = match?.[2];
	if (!previousVersion || !currentVersion) return undefined;
	return { previousVersion, currentVersion };
}

function parseCurrentIdxVersion(output: string): string | undefined {
	return output.match(/already up to date\s*\(v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\)/iu)?.[1];
}

function startupVersionCheckDisabledReason(env: NodeJS.ProcessEnv): string | undefined {
	if (truthyEnv(env.PI_OFFLINE)) return "PI_OFFLINE is set";
	if (truthyEnv(env.PI_SKIP_VERSION_CHECK)) return "PI_SKIP_VERSION_CHECK is set";
	if (truthyEnv(env.PIX_SKIP_VERSION_CHECK)) return "PIX_SKIP_VERSION_CHECK is set";
	return undefined;
}

function truthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

function isCommandNotFoundError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function compactCommandFailure(prefix: string, output: string): string {
	if (!output) return prefix;
	const singleLine = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).slice(-4).join(" | ");
	const summary = singleLine.length > 900 ? `${singleLine.slice(0, 897)}...` : singleLine;
	return `${prefix}: ${summary}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isPiToolsSuiteExtension(extension: LoadExtensionsResult["extensions"][number]): boolean {
	return [
		extension.path,
		extension.resolvedPath,
		extension.sourceInfo.path,
		extension.sourceInfo.source,
		extension.sourceInfo.baseDir,
	].some((value) => value !== undefined && pathLooksLikePiToolsSuite(value));
}

function pathLooksLikePiToolsSuite(value: string): boolean {
	return value.toLowerCase().includes(PI_TOOLS_SUITE_EXTENSION_ID);
}
