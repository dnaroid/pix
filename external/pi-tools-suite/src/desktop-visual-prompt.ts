import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROJECT_ARTIFACTS_DIR } from "./artifact-paths.js";

const SECTION = "desktop_visual_guidance";
export const DESKTOP_VISUAL_GUIDANCE = `For visual explanations (diagrams, layouts, or mockups), prefer SVG files over pseudo/ASCII art. Save them under the current project's ${PROJECT_ARTIFACTS_DIR}/ and include a clickable Markdown file link in your reply. Honor an explicit user-requested format or output location.`;

/** Host guidance, independent of model-specific discipline and optional tools. */
export function registerDesktopVisualPrompt(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (env.PIX_CONFIG_PROFILE?.trim().toLowerCase() !== "desktop") return;
	pi.on("before_agent_start", (event) => {
		// Preserve opaque prompt overrides from earlier handlers as well as the
		// normal structured prompt path. Do not capture an absolute workspace.
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			if (!event.systemPrompt.includes(DESKTOP_VISUAL_GUIDANCE)) {
				return { systemPrompt: `${event.systemPrompt}\n\n<${SECTION}>\n${DESKTOP_VISUAL_GUIDANCE}\n</${SECTION}>` };
			}
			return;
		}
		event.systemPromptOptions.sections[SECTION] = DESKTOP_VISUAL_GUIDANCE;
	});
}
