import { describe, expect, test } from "bun:test";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROJECT_ARTIFACTS_DIR } from "../src/artifact-paths.js";
import { DESKTOP_VISUAL_GUIDANCE, registerDesktopVisualPrompt } from "../src/desktop-visual-prompt.js";

function harness(profile?: string) {
	let handler: ((event: BeforeAgentStartEvent) => any) | undefined;
	registerDesktopVisualPrompt({
		on(name: string, callback: typeof handler) {
			expect(name).toBe("before_agent_start");
			handler = callback;
		},
	} as unknown as ExtensionAPI, { PIX_CONFIG_PROFILE: profile });
	return { run: (event: BeforeAgentStartEvent) => handler?.(event), registered: () => !!handler };
}

function event(cwd = "/project-a", forced?: string): BeforeAgentStartEvent {
	const systemPromptOptions: BeforeAgentStartEvent["systemPromptOptions"] = {
		cwd,
		customPrompt: "Existing instructions",
		forceSystemPrompt: forced,
		sections: { existing: "Keep this section" },
		selectedTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [],
		appendSystemPrompt: "", contextFiles: [], skills: [],
	};
	return { type: "before_agent_start", prompt: "Explain the layout", systemPromptOptions, systemPrompt: forced ?? "Existing instructions" };
}

describe("Desktop visual prompt", () => {
	test("adds concise English SVG and file-link guidance using the shared path", () => {
		const hook = harness(" Desktop ");
		const input = event();
		expect(hook.run(input)).toBeUndefined();
		const hint = input.systemPromptOptions.sections.desktop_visual_guidance;
		expect(hint).toBe(DESKTOP_VISUAL_GUIDANCE);
		expect(hint).toContain(`${PROJECT_ARTIFACTS_DIR}/`);
		expect(hint).toContain("SVG files over pseudo/ASCII art");
		expect(hint).toContain("clickable Markdown file link");
		expect(hint).toContain("explicit user-requested format or output location");
		expect(input.systemPromptOptions.sections.existing).toBe("Keep this section");
		expect(input.systemPromptOptions.customPrompt).toBe("Existing instructions");
		expect(input.systemPromptOptions.forceSystemPrompt).toBeUndefined();
	});

	test("does not register for standalone Pi, TUI, or other ACP hosts", () => {
		for (const profile of [undefined, "", "tui", "acp", "desktop-other"]) {
			expect(harness(profile).registered()).toBe(false);
		}
	});

	test("requires individual image links with resolvable destinations, not a directory and filenames", () => {
		const input = event();
		harness("desktop").run(input);
		const hint = input.systemPromptOptions.sections.desktop_visual_guidance;
		expect(hint).toContain("screenshots and QA evidence");
		expect(hint).toContain("explicit Markdown link to each image");
		expect(hint).toContain(`[Front view](${PROJECT_ARTIFACTS_DIR}/ui-qa/run/front.png)`);
		expect(hint).toContain("inline previews that open on click");
		expect(hint).toContain("directory link followed by bare filenames or inline-code filenames is not sufficient");
		expect(hint).toContain("including .pi/subagents/");
		expect(hint).toContain("absolute file:// Markdown destination");
	});

	test("is idempotent and never caches a workspace path between turns", () => {
		const hook = harness("desktop");
		const first = event();
		hook.run(first);
		hook.run(first);
		expect(Object.values(first.systemPromptOptions.sections).filter((value) => value === DESKTOP_VISUAL_GUIDANCE)).toHaveLength(1);
		const next = event("/project-b");
		hook.run(next);
		expect(next.systemPromptOptions.sections.desktop_visual_guidance).toBe(DESKTOP_VISUAL_GUIDANCE);
		expect(next.systemPromptOptions.sections.desktop_visual_guidance).not.toContain("/project-a");
	});

	test("preserves earlier opaque overrides without duplicating guidance", () => {
		const hook = harness("desktop");
		const result = hook.run(event("/project-a", "Earlier forced prompt"));
		expect(result.systemPrompt).toStartWith("Earlier forced prompt\n\n");
		expect(result.systemPrompt).toContain(DESKTOP_VISUAL_GUIDANCE);
		expect(hook.run(event("/project-b", result.systemPrompt))).toBeUndefined();
	});
});
