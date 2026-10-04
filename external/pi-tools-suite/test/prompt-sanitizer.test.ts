import { describe, expect, test } from "bun:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { registerPromptSanitizer, sanitizeSystemPrompt, stripUpstreamPiDocs } from "../src/prompt-sanitizer.js";

const docs = "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):\n- Main documentation: /sdk/README.md\n- New upstream advice added after an SDK update";

describe("upstream prompt sanitization", () => {
	for (const block of [docs, `<docs>\n${docs}\n</docs>`]) {
		for (const newline of ["\n", "\r\n"]) test(`removes docs at boundaries with ${JSON.stringify(newline)}: ${block.startsWith("<")}`, () => {
			for (const prompt of [block, `${block}\n\n<skills>keep</skills>`, `base\n\n${block}`]) {
				const result = stripUpstreamPiDocs(prompt.replaceAll("\n", newline));
				expect(result).not.toContain("Pi documentation");
				expect(result).not.toContain("<docs>");
				if (prompt.includes("<skills>")) expect(result).toContain("<skills>keep</skills>");
				expect(stripUpstreamPiDocs(result)).toBe(result);
			}
		});
	}

	test("preserves unrelated custom docs and project/skill/addendum contents verbatim", () => {
		for (const tag of ["project_context", "project_instructions", "skills", "available_skills", "addendum"]) {
			const protectedText = `<${tag}>\n<docs>\n${docs}\n</docs>\n</${tag}>`;
			expect(stripUpstreamPiDocs(protectedText)).toBe(protectedText);
		}
		const custom = "<docs>\nProject documentation: read docs/setup.md\n</docs>";
		expect(stripUpstreamPiDocs(custom)).toBe(custom);
	});

	test("preserves structured metadata, other sections and source messages", () => {
		const original: SystemMessage = { role: "system", content: "base", timestamp: 1,
			sections: { docs: `<docs>\n${docs}\n</docs>`, skills: "keep skills", project_context: docs }, toolsAdded: [], toolsRemoved: [] };
		const result = sanitizeSystemPrompt(original);
		expect(result).toEqual({ ...original, sections: { ...original.sections, docs: null } });
		expect(original.sections?.docs).toContain("Pi documentation");
		expect(sanitizeSystemPrompt(result)).toEqual(result);
		expect(sanitizeSystemPrompt({ ...original, content: [{ type: "text", text: docs }] }).content).toEqual([{ type: "text", text: "" }]);
	});

	test("registers a model-independent request transform and leaves conversation messages alone", () => {
		const handlers = new Map<string, any>();
		registerPromptSanitizer({ on(name: string, fn: unknown) { handlers.set(name, fn); } } as any);
		const handler = handlers.get("context_with_system");
		const options = { forceSystemPrompt: docs };
		handlers.get("before_agent_start")({ systemPromptOptions: options });
		expect(options.forceSystemPrompt).toBe("");
		const structured = {};
		handlers.get("before_agent_start")({ systemPromptOptions: structured });
		expect(structured).toEqual({});
		const user = { role: "user", content: docs, timestamp: 2 };
		const messages = [{ role: "system", content: docs, timestamp: 1 }, user];
		for (const model of ["glm", "gpt", "claude"]) {
			const result = handler({ messages }, { model });
			expect(result.messages[0].content).toBe("");
			expect(result.messages[1]).toBe(user);
		}
	});
});
