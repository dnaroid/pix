import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants as fsConstants } from "node:fs";

import type { AgentSessionRuntime, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

const PI_CLI_COMMAND = "pi";
const PI_TOOLS_SUITE_EXTENSION_ID = "pi-tools-suite";

export type StartupAvailabilityIssue = {
	kind: "warning" | "error";
	message: string;
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
