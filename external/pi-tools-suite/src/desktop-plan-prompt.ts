import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SECTION = "desktop_plan_guidance";
export const DESKTOP_PLAN_GUIDE_PATH = fileURLToPath(new URL("../docs/plan-writing.md", import.meta.url));
export const DESKTOP_PLAN_GUIDANCE = `Save durable implementation plans as Markdown in the current project's .pi/plans/<descriptive-name>.md (nested folders allowed), unless the user requests another location. Create one only when requested, when review is needed before execution, or when work clearly spans sessions. Before creating or materially revising a plan, read ${JSON.stringify(DESKTOP_PLAN_GUIDE_PATH)} only if its full guidance is absent from the current context. Do not load it just to browse, execute or tick verified checkboxes in an existing plan. Do not create plan files for trivial work or ordinary answers.`;

/** Desktop host policy; the detailed authoring guide is never eagerly loaded. */
export function registerDesktopPlanPrompt(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (env.PIX_CONFIG_PROFILE?.trim().toLowerCase() !== "desktop") return;
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			if (!event.systemPrompt.includes(DESKTOP_PLAN_GUIDANCE)) {
				return { systemPrompt: `${event.systemPrompt}\n\n<${SECTION}>\n${DESKTOP_PLAN_GUIDANCE}\n</${SECTION}>` };
			}
			return;
		}
		event.systemPromptOptions.sections[SECTION] = DESKTOP_PLAN_GUIDANCE;
	});
}
