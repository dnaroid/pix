import { describe, expect, test } from "bun:test";
import {
	CODEX_ALIAS_TOOL_DESCRIPTIONS,
	COMPRESS_TOOL_DESCRIPTION,
	TODO_TOOL_DESCRIPTION,
	asyncSubagentToolDescriptions,
} from "../src/tool-descriptions.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../src/dcp/prompts.js";

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

	test("compress prompt encourages context-pressure housekeeping after completed work", () => {
		const promptText = [
			COMPRESS_TOOL_DESCRIPTION.description,
			COMPRESS_TOOL_DESCRIPTION.promptSnippet,
			...(COMPRESS_TOOL_DESCRIPTION.promptGuidelines ?? []),
		].join("\n");

		expect(promptText).toContain("implementation, verification");
		expect(promptText).toContain("Low context usage by itself does not require compression");
		expect(promptText).toContain("context-pressure housekeeping");
		expect(promptText).toContain("large stale shell/read/repo/web outputs");
		expect(COMPRESS_TOOL_DESCRIPTION.description).toBe(COMPRESS_RANGE_DESCRIPTION);
	});

	test("todo prompt locks the model-facing workflow invariants", () => {
		const promptText = [
			TODO_TOOL_DESCRIPTION.description,
			TODO_TOOL_DESCRIPTION.promptSnippet,
			...(TODO_TOOL_DESCRIPTION.promptGuidelines ?? []),
		].join("\n");

		expect(promptText).toContain("complex work with 3+ steps");
		expect(promptText).toContain("Skip single trivial tasks");
		expect(promptText).toContain("final user-facing report todo");
		expect(promptText).toContain("changed files/behavior, verification results, and remaining manual actions");
		expect(promptText).toContain("close it immediately before the final response");
		expect(promptText).toContain("do not issue a redundant update");
		expect(promptText).toContain("Resync before continuing");
		expect(promptText).toContain("exactly one in_progress");
		expect(promptText).toContain("Never use `clear`, `delete`");
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
