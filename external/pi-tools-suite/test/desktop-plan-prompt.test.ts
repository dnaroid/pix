import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DESKTOP_PLAN_GUIDANCE, DESKTOP_PLAN_GUIDE_PATH, registerDesktopPlanPrompt } from "../src/desktop-plan-prompt.js";
import { registerDesktopVisualPrompt } from "../src/desktop-visual-prompt.js";

function event(cwd = "/project-a", forced?: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start", messageType: "user", prompt: "Write an implementation plan", systemPrompt: forced ?? "Base prompt",
		systemPromptOptions: {
			cwd, forceSystemPrompt: forced, customPrompt: "Base prompt", sections: { existing: "Keep this" },
			selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
			appendSystemPrompt: "", contextFiles: [], skills: [],
		},
	};
}

function harness(profile?: string) {
	let handler: ((input: BeforeAgentStartEvent) => any) | undefined;
	registerDesktopPlanPrompt({ on: (_name: string, callback: typeof handler) => { handler = callback; } } as unknown as ExtensionAPI,
		{ PIX_CONFIG_PROFILE: profile });
	return { registered: () => !!handler, run: (input: BeforeAgentStartEvent) => handler?.(input) };
}

describe("Desktop lazy plan-writing guidance", () => {
	test("resolves the readable guide from a relocated installation, including spaces and Unicode", async () => {
		const root = fileURLToPath(new URL("../../../", import.meta.url));
		const artifacts = join(root, ".pi/artifacts");
		await mkdir(artifacts, { recursive: true });
		const temp = await mkdtemp(join(artifacts, "plan-guide-runtime-"));
		try {
			const installed = join(temp, "installed suite правила");
			await mkdir(join(installed, "src"), { recursive: true });
			await mkdir(join(installed, "docs"));
			await cp(fileURLToPath(new URL("../src/desktop-plan-prompt.ts", import.meta.url)), join(installed, "src/desktop-plan-prompt.ts"));
			await cp(DESKTOP_PLAN_GUIDE_PATH, join(installed, "docs/plan-writing.md"));
			const relocated = await import(pathToFileURL(join(installed, "src/desktop-plan-prompt.ts")).href);
			expect(relocated.DESKTOP_PLAN_GUIDE_PATH).toBe(join(installed, "docs/plan-writing.md"));
			expect(relocated.DESKTOP_PLAN_GUIDANCE).toContain(JSON.stringify(relocated.DESKTOP_PLAN_GUIDE_PATH));
			expect(readFileSync(relocated.DESKTOP_PLAN_GUIDE_PATH, "utf8")).toBe(readFileSync(DESKTOP_PLAN_GUIDE_PATH, "utf8"));
			const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
			expect(pkg.files).toContain("external/pi-tools-suite/docs");
			expect(pkg.files).toContain("external/pi-tools-suite/src");
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	});

	test("injects only the storage rule and a readable shipped guide reference", () => {
		const input = event();
		expect(harness(" Desktop ").run(input)).toBeUndefined();
		const hint = input.systemPromptOptions.sections.desktop_plan_guidance!;
		expect(hint).toBe(DESKTOP_PLAN_GUIDANCE);
		expect(hint).toContain(".pi/plans/<descriptive-name>.md");
		expect(hint).toContain("unless the user requests another location");
		expect(hint).toContain(JSON.stringify(DESKTOP_PLAN_GUIDE_PATH));
		expect(hint).toContain("Before creating or materially revising a plan");
		expect(hint).toContain("only if its full guidance is absent");
		expect(hint).toContain("Do not load it just to browse, execute or tick verified checkboxes");
		expect(hint).toContain("Do not create plan files for trivial work");
		expect(hint.length).toBeLessThan(1100);
		const fullGuide = readFileSync(DESKTOP_PLAN_GUIDE_PATH, "utf8");
		expect(fullGuide).toContain("# Writing implementation plans");
		expect(hint).not.toContain(fullGuide);
		expect(input.systemPromptOptions.sections.existing).toBe("Keep this");
		expect(input.systemPromptOptions.forceSystemPrompt).toBeUndefined();
	});

	test("does not register for non-Desktop hosts", () => {
		for (const profile of [undefined, "", "tui", "acp", "desktop-other"]) expect(harness(profile).registered()).toBe(false);
	});

	test("is idempotent across turns without capturing the project workspace", () => {
		const hook = harness("desktop");
		for (const cwd of ["/project-a", "/project-b"]) {
			const input = event(cwd);
			hook.run(input);
			hook.run(input);
			expect(Object.values(input.systemPromptOptions.sections).filter((value) => value === DESKTOP_PLAN_GUIDANCE)).toHaveLength(1);
			expect(input.systemPromptOptions.sections.desktop_plan_guidance).not.toContain(cwd);
		}
		const result = hook.run(event("/project-a", "Opaque earlier prompt"));
		expect(result.systemPrompt).toStartWith("Opaque earlier prompt\n\n");
		expect(result.systemPrompt).toContain(DESKTOP_PLAN_GUIDANCE);
		expect(hook.run(event("/project-b", result.systemPrompt))).toBeUndefined();
	});

	test("composes with the visual inject for structured prompts and forced overrides", () => {
		const handlers: Array<(input: BeforeAgentStartEvent) => any> = [];
		const api = { on: (_name: string, callback: (input: BeforeAgentStartEvent) => any) => handlers.push(callback) } as unknown as ExtensionAPI;
		registerDesktopVisualPrompt(api, { PIX_CONFIG_PROFILE: "desktop" });
		registerDesktopPlanPrompt(api, { PIX_CONFIG_PROFILE: "desktop" });
		for (const forced of [undefined, "Custom override"]) {
			let input = event("/project", forced);
			for (const handler of handlers) {
				const result = handler(input);
				if (result?.systemPrompt) {
					input = { ...input, systemPrompt: result.systemPrompt };
					input.systemPromptOptions.forceSystemPrompt = result.systemPrompt;
				}
			}
			if (forced) {
				expect(input.systemPrompt).toStartWith(forced);
				expect(input.systemPrompt).toContain("<desktop_visual_guidance>");
				expect(input.systemPrompt).toContain("<desktop_plan_guidance>");
			} else {
				expect(input.systemPromptOptions.sections.desktop_visual_guidance).toBeDefined();
				expect(input.systemPromptOptions.sections.desktop_plan_guidance).toBe(DESKTOP_PLAN_GUIDANCE);
			}
		}
	});
});
