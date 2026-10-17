import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const BRAINSTORM_SKILL_PATH = fileURLToPath(new URL("./skill/SKILL.md", import.meta.url));
export const COUNCIL_USAGE = "Usage: /brainstorm [--mode auto|brainstorm|audit] [--models provider/model:effort,...] <topic and constraints>";

/**
 * The council is a skill: this module only ships it and keeps /brainstorm as
 * a shortcut. Rounds, roster and protocol live in skill/ (SKILL.md, prompts.md,
 * scripts/council.mjs); participants are ordinary async sub-agents.
 */
export default function brainstormExtension(pi: ExtensionAPI): void {
	pi.on("resources_discover", () => ({ skillPaths: [BRAINSTORM_SKILL_PATH] }));

	pi.registerCommand("brainstorm", {
		description: "Five-round multi-model council skill; --mode brainstorm|audit, --models provider/model:effort,... for this run only",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify(`${COUNCIL_USAGE}. Runs the brainstorm skill: one persistent research sub-agent per configured model for five paid rounds, plus parent synthesis and revision.`, "info");
				return;
			}
			await ctx.waitForIdle();
			pi.sendUserMessage(`/skill:brainstorm ${request}`, { expandPromptTemplates: true });
		},
	});
}
