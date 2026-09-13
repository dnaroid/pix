import type { AntigravityModel, HeaderStyle } from "./types";
import { AGY_CLI_CHANGE_LIST, AGY_CLI_VERSION } from "./constants";

function normalizePlatform(platform = process.platform): string {
	return platform === "win32" ? "windows" : platform || "unknown";
}

function normalizeArch(arch = process.arch): string {
	switch (arch) {
		case "x64":
			return "amd64";
		case "ia32":
			return "386";
		default:
			return arch || "unknown";
	}
}

/** Native agy CLI 1.1.24 content-request identity captured by cortexkit 2.2.1. */
export function buildAntigravityHarnessUserAgent(
	version = AGY_CLI_VERSION,
	platform = process.platform,
	arch = process.arch,
	authMethod = "consumer",
): string {
	const changeList = version === AGY_CLI_VERSION ? `; cl=${AGY_CLI_CHANGE_LIST}` : "";
	return `antigravity/cli/${version} (aidev_client; os_type=${normalizePlatform(platform)}; arch=${normalizeArch(arch)}${changeList}; auth_method=${authMethod})`;
}

export function getAntigravityBootstrapHeaders(accessToken: string): Record<string, string> {
	return {
		"User-Agent": buildAntigravityHarnessUserAgent(),
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"Accept-Encoding": "gzip",
	};
}

export function getAntigravityLoadCodeAssistMetadata(): Record<string, string> {
	return { ideType: "ANTIGRAVITY" };
}

export function getAntigravityHeaders(style: "antigravity" | "gemini-cli" = "antigravity"): Record<string, string> {
	if (style === "gemini-cli") {
		return {
			"User-Agent": "google-api-nodejs-client/9.15.1",
			"X-Goog-Api-Client": "gl-node/22.17.0",
			"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		};
	}
	return {
		"User-Agent": buildAntigravityHarnessUserAgent(),
	};
}

export function getModelHeaderStyle(model: AntigravityModel): HeaderStyle {
	return model.antigravityHeaderStyle ?? "antigravity";
}
