import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentMarkdown } from "../src/registry/agent-markdown.js";
import { parseAgentMarkdown as suiteParse } from "../../external/pi-tools-suite/src/async-subagents/core/agents-dir.js";

test("Desktop Registry agent metadata parser stays compatible with the suite parser", () => {
	const fixtures = [
		"Plain body without frontmatter.",
		"\uFEFF---\r\nname: demo\r\ntags: [Local, 'Code review']\r\n---\r\n\r\nBody.\r\n",
		"---\nname: review\ndescription: Review code\nmodels:\n  - provider/model\ntags:\n  - code\n  - 'two words'\ntools: [read, shell]\n---\nBody.\n",
		"---\nname: review\nunknown: value\n---\nBody.\n",
		"---\nname: review\ntags: scalar\n---\nBody.\n",
		"---\nname: review\ntags: [code, 3]\n---\nBody.\n",
		"---\nname: review\ntags: [unterminated\n---\nBody.\n",
		"---\nname: review\nname: duplicate\n---\nBody.\n",
		"---\nname: review\ndescription: |\n  unsupported block\n---\nBody.\n",
	];
	const outcome = (parse: typeof parseAgentMarkdown, source: string) => {
		try { return { value: parse(source, "agent.md") }; }
		catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
	};
	for (const fixture of fixtures) {
		assert.deepEqual(outcome(parseAgentMarkdown, fixture), outcome(suiteParse, fixture), fixture);
	}
});
