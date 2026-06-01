import { describe, expect, test } from "bun:test";
import { CODEX_ALIAS_TOOL_DESCRIPTIONS, COMPRESS_TOOL_DESCRIPTION, asyncSubagentToolDescriptions } from "../src/tool-descriptions.js";

describe("tool descriptions", () => {
	test("apply_patch prompt documents begin-patch and unified diff support", () => {
		const promptText = CODEX_ALIAS_TOOL_DESCRIPTIONS.applyPatch.description;

		expect(promptText).toContain("unified diff");
		expect(promptText).toContain("*** Begin Patch");
		expect(promptText).toContain("*** Move to:");
		expect(promptText).toContain("*** End of File");
		expect(promptText).toContain("<<EOF");
		expect(promptText).toContain("workspace-relative");
	});

	test("compress prompt encourages steady housekeeping after completed work", () => {
		const promptText = [
			COMPRESS_TOOL_DESCRIPTION.description,
			COMPRESS_TOOL_DESCRIPTION.promptSnippet,
			...(COMPRESS_TOOL_DESCRIPTION.promptGuidelines ?? []),
		].join("\n");

		expect(promptText).toContain("implementation + verification");
		expect(promptText).toContain("before replying or starting a new task");
		expect(promptText).toContain("large stale tool outputs");
	});

	test("subagents prompt keeps explicit delegation triggers in repo-aware mode", () => {
		const tool = asyncSubagentToolDescriptions(true).subagents;
		const promptText = [tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("delegate/parallelize/split work");
		expect(promptText).toContain("spawn triggers");
		expect(promptText).toContain("do not let repo_* availability suppress delegation");
		expect(promptText).toContain("one discovery question");
	});

	test("subagents prompt prioritizes broad fallback delegation when repo tools are unavailable", () => {
		const tool = asyncSubagentToolDescriptions(false).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("repo_* tools are unavailable");
		expect(promptText).toContain("incident-triage hypotheses");
		expect(promptText).toContain("spawn several focused scan/quick agents first");
		expect(promptText).toContain("call action='spawn' as the first discovery step");
	});
});
