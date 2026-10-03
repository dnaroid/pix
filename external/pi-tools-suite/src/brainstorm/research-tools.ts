import { fileURLToPath } from "node:url";
import { REPO_DISCOVERY_TOOLS } from "../tool-descriptions.js";

export const COUNCIL_RESEARCH_TOOLS = [
	"read", "grep", "web_search", "web_fetch",
	...REPO_DISCOVERY_TOOLS.map((tool) => tool.name),
];

export function councilResearchArgs(): string[] {
	// --tools is a hard SDK registry allowlist. Override the runner's model
	// aliases: custom names must survive and grep must never become shell.
	return ["--extension", fileURLToPath(new URL("./research-extension.ts", import.meta.url)),
		"--tools", COUNCIL_RESEARCH_TOOLS.join(",")];
}
