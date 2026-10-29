import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProjectWikiPrompt } from "../src/project-wiki-prompt.js";

const artifactRoot = fileURLToPath(new URL("../../../.pi/artifacts/", import.meta.url));
mkdirSync(artifactRoot, { recursive: true });
const fixtureRoot = mkdtempSync(join(artifactRoot, "wiki-prompt-fixtures-"));
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function workspace(): string { return mkdtempSync(join(fixtureRoot, "project-")); }
function file(cwd: string, path: string, content = "# Wiki\n"): void {
	mkdirSync(dirname(join(cwd, path)), { recursive: true });
	writeFileSync(join(cwd, path), content);
}
function event(cwd: string, forced?: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start", messageType: "user", prompt: "Write project documentation",
		systemPrompt: forced ?? "Existing instructions",
		systemPromptOptions: {
			cwd, customPrompt: "Existing instructions", forceSystemPrompt: forced,
			sections: { existing: "Keep this section" }, selectedTools: [], toolSnippets: {},
			toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", contextFiles: [], skills: [],
		},
	};
}
function harness() {
	let handler: (event: BeforeAgentStartEvent) => any;
	registerProjectWikiPrompt({
		on(name: string, callback: typeof handler) {
			expect(name).toBe("before_agent_start");
			handler = callback;
			return () => {};
		},
	} as unknown as ExtensionAPI);
	return (input: BeforeAgentStartEvent) => handler(input);
}

describe("initialized project Wiki prompt", () => {
	test("does not create or advertise an uninitialized Wiki", async () => {
		const cwd = workspace(), run = harness(), input = event(cwd);
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		expect(existsSync(join(cwd, "wiki"))).toBe(false);
		mkdirSync(join(cwd, "wiki"));
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
	});

	test("recognizes the default index without requiring a workspace config", async () => {
		const cwd = workspace(), input = event(cwd);
		file(cwd, "wiki/index.md");
		await harness()(input);
		const hint = input.systemPromptOptions.sections.project_wiki_guidance;
		expect(hint).toContain('documentation and specifications in "wiki/"');
		expect(hint).toContain('"wiki/index.md"');
		expect(hint).toContain("durable project documentation");
		expect(hint).toContain("index links current");
		expect(hint).toContain("explicit user-requested locations and required fixed-path files");
		expect(input.systemPromptOptions.sections.existing).toBe("Keep this section");
	});

	test("uses configured nested JSONC paths only after the configured index exists", async () => {
		const cwd = workspace(), input = event(cwd), run = harness();
		file(cwd, ".pi/workspace.jsonc", '// Project preferences\n{"wiki":{"path":"docs/game","index":"overview/home.md",},}');
		file(cwd, "wiki/index.md");
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		file(cwd, "docs/game/overview/home.md");
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toContain('"docs/game/"');
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toContain('"docs/game/overview/home.md"');
	});

	for (const source of ["{broken", '{"wiki":{"path":"../escape"}}', '{"wiki":{"path":".pi/artifacts/wiki"}}']) {
		test(`invalid config does not fall back to an existing default Wiki: ${source}`, async () => {
			const cwd = workspace(), input = event(cwd);
			file(cwd, "wiki/index.md");
			file(cwd, ".pi/workspace.jsonc", source);
			input.systemPromptOptions.sections.project_wiki_guidance = "Stale project";
			await harness()(input);
			expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		});
	}

	test("a directory named index.md is not an initialized index", async () => {
		const cwd = workspace(), input = event(cwd);
		mkdirSync(join(cwd, "wiki/index.md"), { recursive: true });
		await harness()(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
	});

	test("does not follow the index or workspace configuration outside the project", async () => {
		const outside = workspace();
		file(outside, "index.md");
		file(outside, "workspace.jsonc", "{}");
		for (const target of ["index", "config"]) {
			const cwd = workspace(), input = event(cwd);
			if (target === "index") {
				mkdirSync(join(cwd, "wiki"));
				symlinkSync(join(outside, "index.md"), join(cwd, "wiki/index.md"));
			} else {
				file(cwd, "wiki/index.md");
				mkdirSync(join(cwd, ".pi"));
				symlinkSync(join(outside, "workspace.jsonc"), join(cwd, ".pi/workspace.jsonc"));
			}
			await harness()(input);
			expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		}
	});

	test("refreshes config, index removal and project ownership without cached paths", async () => {
		const cwd = workspace(), next = workspace(), input = event(cwd), run = harness();
		file(cwd, "wiki/index.md");
		await run(input);
		await run(input);
		expect(Object.keys(input.systemPromptOptions.sections).filter(key => key === "project_wiki_guidance")).toHaveLength(1);
		file(cwd, ".pi/workspace.jsonc", '{"wiki":{"path":"handbook"}}');
		file(cwd, "handbook/index.md");
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toContain('"handbook/"');
		expect(input.systemPromptOptions.sections.project_wiki_guidance).not.toContain('"wiki/"');
		rmSync(join(cwd, "handbook/index.md"));
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		input.systemPromptOptions.cwd = next;
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toBeUndefined();
		file(next, "wiki/index.md");
		await run(input);
		expect(input.systemPromptOptions.sections.project_wiki_guidance).toContain('"wiki/"');
	});

	test("preserves opaque overrides while refreshing or removing only its own block", async () => {
		const cwd = workspace(), run = harness(), original = "Keep my custom prompt\n<other>Important</other>";
		file(cwd, "wiki/index.md");
		const first = await run(event(cwd, original));
		expect(first.systemPrompt).toStartWith(original + "\n\n");
		expect(first.systemPrompt.match(/<project_wiki_guidance>/gu)).toHaveLength(1);
		expect(await run(event(cwd, first.systemPrompt))).toBeUndefined();
		file(cwd, ".pi/workspace.jsonc", '{"wiki":{"path":"handbook"}}');
		file(cwd, "handbook/index.md");
		const updated = await run(event(cwd, first.systemPrompt));
		expect(updated.systemPrompt).toContain('"handbook/"');
		expect(updated.systemPrompt).not.toContain('"wiki/"');
		rmSync(join(cwd, "handbook/index.md"));
		const removed = await run(event(cwd, updated.systemPrompt));
		expect(removed.systemPrompt).toBe(original);
	});

	test("quotes XML-significant path characters without injecting section delimiters", async () => {
		// Windows forbids angle brackets in filenames; ampersands are valid on every platform.
		const path = process.platform === "win32" ? "docs/project_wiki_guidance&notes" : "docs/<project_wiki_guidance>&notes";
		const cwd = workspace();
		file(cwd, ".pi/workspace.jsonc", JSON.stringify({ wiki: { path } }));
		file(cwd, path + "/index.md");
		const result = await harness()(event(cwd, "Original"));
		expect(result.systemPrompt.match(/<project_wiki_guidance>/gu)).toHaveLength(1);
		const expectedPath = process.platform === "win32"
			? '"docs/project_wiki_guidance\\u0026notes/"'
			: '"docs/\\u003cproject_wiki_guidance\\u003e\\u0026notes/"';
		expect(result.systemPrompt).toContain(expectedPath);
	});
});
