import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeCliResponse } from "../../src/async-subagents/agents/ui-qa/drivers/chrome-devtools/cli-response.mjs";
import { runBrowserBackend } from "../../src/async-subagents/agents/ui-qa/backends/browser.mjs";

test("preserves structured page responses", () => {
	const data = { pages: [{ id: 0, url: "https://example.test/", selected: true }] };
	expect(decodeCliResponse(JSON.stringify(data), "new_page")).toEqual(data);
});

test("recognizes exit-zero MCP error content without leaking it", () => {
	for (const data of [
		[{ type: "text", text: "private-token https://private.test/" }],
		{ isError: true, content: [{ type: "text", text: "private-token" }] },
	]) {
		const decode = () => decodeCliResponse(JSON.stringify(data), "new_page");
		expect(decode).toThrow("new_page reported an MCP tool error");
		expect(decode).not.toThrow("private-token");
	}
});

test("rejects absent or malformed page records", () => {
	for (const pages of [undefined, [], [{ id: "1", url: "https://example.test" }], [{ id: 1 }], [null]]) {
		for (const command of ["new_page", "list_pages"]) {
			expect(() => decodeCliResponse(JSON.stringify({ pages }), command)).toThrow("missing or invalid page records");
		}
	}
});

test("rejects empty, invalid and legacy unstructured responses", () => {
	for (const text of ["", "not json", "null", "1", '[]', '["legacy text"]']) {
		expect(() => decodeCliResponse(text, "new_page")).toThrow();
	}
});

test("preserves other structured command results", () => {
	expect(decodeCliResponse('{"snapshot":{}}', "take_snapshot")).toEqual({ snapshot: {} });
});

test("fake CLI exit-zero error fails before page actions and stops its session", async () => {
	if (process.platform === "win32") return;
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "devtools-error-"));
	try {
		const fakeCli = path.join(project, "fake-cli.mjs");
		const log = path.join(project, "calls.jsonl");
		fs.writeFileSync(fakeCli, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "--version") console.log("1.9.0");
else if (args[0] === "new_page") console.log(JSON.stringify([{type:"text",text:"private-token connection failed"}]));
else if (!["start", "stop"].includes(args[0])) process.exit(2);
`, { mode: 0o700 });
		const result = await runBrowserBackend({
			flow: { target: { url: "https://example.test/", browserDriver: "chrome-devtools" }, steps: [{ action: "snapshotAccessibility" }] },
			projectRoot: project, agentDir: project, evidenceDir: project,
			runId: "offline-error", deadline: Date.now() + 20_000,
			chromeDevtoolsPath: fakeCli,
			artifact(value: string) { return { path: path.join(project, value) }; },
			progress() {},
		});
		expect(result.status).toBe("FAILED");
		expect(result.reason).toContain("new_page reported an MCP tool error");
		expect(JSON.stringify(result)).not.toContain("private-token");
		const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(calls.filter((args) => args[0] === "new_page")).toHaveLength(1);
		expect(calls.some((args) => ["take_snapshot", "close_page"].includes(args[0]))).toBe(false);
		const start = calls.find((args) => args[0] === "start");
		const stop = calls.find((args) => args[0] === "stop");
		expect(stop).toContain(start[start.indexOf("--sessionId") + 1]);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
});
