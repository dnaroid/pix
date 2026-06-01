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
	];
}

export async function checkPiCliAvailability(pathValue = process.env.PATH ?? ""): Promise<StartupAvailabilityIssue[]> {
	if (await executableExistsOnPath(PI_CLI_COMMAND, pathValue)) return [];

	return [{
		kind: "error",
		message: "pi CLI is not available on PATH. Install pi or add it to PATH before starting pix.",
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
	for (const dir of dirs) {
		try {
			await access(join(dir, command), fsConstants.X_OK);
			return true;
		} catch {
			// Keep scanning PATH entries.
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
