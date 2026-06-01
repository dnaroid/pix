import type { AntigravityModel, HeaderStyle } from "./types";

export function getAntigravityHeaders(style: "antigravity" | "gemini-cli" = "antigravity"): Record<string, string> {
	if (style === "gemini-cli") {
		return {
			"User-Agent": "google-api-nodejs-client/9.15.1",
			"X-Goog-Api-Client": "gl-node/22.17.0",
			"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		};
	}
	return {
		"User-Agent": "antigravity/1.18.3 darwin/arm64",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${process.platform === "win32" ? "WINDOWS" : "MACOS"}","pluginType":"GEMINI"}`,
	};
}

export function getModelHeaderStyle(model: AntigravityModel): HeaderStyle {
	return model.antigravityHeaderStyle ?? "antigravity";
}
