import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { COUNCIL_GUARD_TOOLS } from "../../src/brainstorm/skill/council-guard.ts";
import { COUNCIL_TOOLS } from "../../src/brainstorm/skill/scripts/lib/protocol.mjs";
import { loadTemplates, parseTemplates, PROMPTS_PATH, render, roundPrompt } from "../../src/brainstorm/skill/scripts/lib/prompts.mjs";
import { extractLedger, parseLedgerRows, renderPositionMatrix } from "../../src/brainstorm/skill/scripts/lib/ledger.mjs";

describe("council prompts", () => {
	test("shipped templates are complete and titled", async () => {
		const templates = await loadTemplates();
		expect(templates["brainstorm-1"].title).toBe("Independent ideas");
		expect(templates["audit-5"].title).toBe("Audit report review");
	});

	test("missing templates and unknown placeholders are errors", () => {
		const text = readFileSync(PROMPTS_PATH, "utf8");
		expect(() => parseTemplates(text.replace("## ledger", "## ledgerx"))).toThrow(/ledger/);
		expect(() => parseTemplates(`${text}\n## ledger\n\ndup\n`)).toThrow(/Duplicate/);
		expect(() => render("Hi {{who}}", {})).toThrow(/who/);
		expect(render("{{a}}", { a: "{{b}}" })).toBe("{{b}}");
	});

	test("round prompts carry brief, ledger and mode rules by round", async () => {
		const templates = await loadTemplates();
		const first = roundPrompt(templates, { mode: "audit", round: 1, slot: 2, model: "x/y", topic: "T", brief: "BRIEF" });
		expect(first).toContain("<<<UNTRUSTED PARTICIPANT CONTENT>>>\nBRIEF");
		expect(first).toContain("Severity and confidence are separate");
		expect(first).toContain("P2-…");
		const fifth = roundPrompt(templates, { mode: "brainstorm", round: 5, slot: 1, model: "x/y", topic: "T", brief: "B", peers: [{ id: "round-4-participant-2", model: "m/2", text: "PEER" }], draft: "DRAFT" });
		expect(fifth).not.toContain("BRIEF");
		expect(fifth).not.toContain("## Ledger\" markdown table");
		expect(fifth).toContain("PEER");
		expect(fifth).toContain("DRAFT");
	});

	test("guard and helper share one read-only allowlist", () => {
		expect(COUNCIL_GUARD_TOOLS).toEqual(COUNCIL_TOOLS);
	});

	test("ledgers feed the position matrix", () => {
		const text = "Body\n\n## Ledger\n| ID | Stance | Refs | Note |\n| --- | --- | --- | --- |\n| `P1-H1` | NEW | | first |\n\n## After\nignored";
		expect(extractLedger(text).found).toBe(true);
		expect(parseLedgerRows(text)).toEqual([{ id: "P1-H1", stance: "new", refs: "", note: "first" }]);
		expect(renderPositionMatrix([{ round: 1, responses: [{ slot: 1, text }, { slot: 2, text: "no ledger" }] }])).toContain("| P1-H1 | new |  | first |");
		expect(extractLedger("plain").found).toBe(false);
	});
});
