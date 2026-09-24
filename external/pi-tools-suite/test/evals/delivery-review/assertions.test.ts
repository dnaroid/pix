import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { auditActions, hasConfidence, parseOutput, shellAudit, snapshot } from "./assertions.js";

describe("delivery review eval audit", () => {
	test("audits shell mutation, tests, UI and nested execution rather than only tool names", () => {
		for (const command of ["echo fixed > src.js", "sed -i 's/a/b/' src.js", "node --test", "npm test", "playwright test", "python -c 'edit()'", "git diff; rm src.js", "find . -exec rm {} \\;", "cat $(touch x)", "rg --pre touch foo", "git diff --output=out"]) {
			expect(shellAudit(command).length, command).toBeGreaterThan(0);
		}
		expect(shellAudit("pwd && ls -la && git diff -- src.js | head -n 80")).toEqual([]);
		expect(shellAudit("nl -ba src/total.js")).toEqual([]);
		expect(shellAudit("git branch --show-current")).toEqual([]);
		expect(shellAudit("git branch -D main")).not.toEqual([]);
		expect(shellAudit("find . -type f | sort")).toEqual([]);
		expect(shellAudit("sort -o source.js source.js")).not.toEqual([]);
		expect(auditActions([{ name: "write", args: {} }])).toEqual(["forbidden tool: write"]);
	});
	test("retains negated readiness for human review, never grades semantic approval via keywords", () => {
		const text = "Not release-ready. High-impact risk remains. Confidence: Low.";
		const output = parseOutput(JSON.stringify({ type: "message_end", message: { role: "assistant", model: "gpt-6-sol", content: [{ type: "text", text }] } }));
		expect(output.text).toBe(text);
		expect(hasConfidence(output.text)).toBe(true);
		expect(hasConfidence("Ready to go")).toBe(false);
	});
	test("reads real execution actions and assistant model metadata", () => {
		const output = parseOutput([
			{ type: "tool_execution_start", toolName: "bash", args: { command: "node --test" } },
			{ type: "message_end", message: { role: "assistant", model: "other", content: [] } },
		].map(event => JSON.stringify(event)).join("\n"));
		expect(output.models).toEqual(["other"]);
		expect(auditActions(output.actions)).toHaveLength(1);
	});
	test("snapshots nested files, links and creations without reading directories as files", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-snapshot-"));
		try {
			fs.mkdirSync(path.join(dir, "src"));
			fs.writeFileSync(path.join(dir, "src/a"), "old");
			fs.symlinkSync("src/a", path.join(dir, "link"));
			const before = snapshot(dir);
			expect(before.link).toBe(`link:${path.join("src", "a")}`);
			fs.writeFileSync(path.join(dir, "src/a"), "new");
			expect(snapshot(dir)).not.toEqual(before);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
