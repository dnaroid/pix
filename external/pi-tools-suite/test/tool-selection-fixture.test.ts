import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { makeToolSelectionFixture, writeToolSelectionIdx } from "./tool-selection-fixture.js";
import { resolveEvalOutputDir } from "./evals/harness/output-dir.js";
import { findIndexedProjectRoot, findProjectRoot } from "../src/lib/project.js";
import { parseIdxHits } from "../src/project-search/engine.js";
import { loadPiToolsSuiteConfig } from "../src/config.js";
import { runSelectionProcess } from "./tool-selection-process.js";

const root = resolveEvalOutputDir("tool-selection-contracts");
fs.mkdirSync(path.join(root, ".indexer-cli"), { recursive: true });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("tool-selection fixture contracts", () => {
	test("non-indexed fixture cannot inherit its parent's index", () => {
		const dir = makeToolSelectionFixture(root, { indexed: false });
		expect(findProjectRoot(path.join(dir, "src"))).toBe(dir);
		expect(findIndexedProjectRoot(dir)).toBeUndefined();
	});
	test("indexed fixture owns its template and direct audit fallback catalog", () => {
		const dir = makeToolSelectionFixture(root, { indexed: true });
		expect(findIndexedProjectRoot(dir)).toBe(dir);
		expect(fs.readFileSync(path.join(dir, ".indexer-cli", "spec-template.md"), "utf8")).toContain("kind: spec");
		const config = loadPiToolsSuiteConfig([], { cwd: dir, includeUserConfig: false, env: {} });
		expect(config.disabledBuiltinAgents).toContain("knowledge-auditor");
	});
	test("fake search matches the real parser and references existing sources", () => {
		const dir = makeToolSelectionFixture(root, { indexed: true });
		const idx = path.join(writeToolSelectionIdx(dir), "idx");
		for (const [kind, domain] of [["code", "code"], ["knowledge", "document"]] as const) {
			const result = spawnSync("node", [idx, "search", "payment retry", "--domain", domain], { cwd: dir, encoding: "utf8" });
			expect(result.status).toBe(0);
			const hits = parseIdxHits(result.stdout, kind);
			expect(hits).toHaveLength(1);
			expect(fs.existsSync(path.join(dir, hits[0]!.path!))).toBe(true);
		}
		const missing = spawnSync("node", [idx, "context", "shipment freeze"], { cwd: dir, encoding: "utf8" });
		expect(missing.stdout).toContain("No primary knowledge matched");
		const unsupported = spawnSync("node", [idx, "invented"], { cwd: dir, encoding: "utf8" });
		expect(unsupported.status).toBe(1);
	});
	test("process runner drains output and preserves failure exit", async () => {
		const result = await runSelectionProcess("node", ["-e", "console.log('out');console.error('err');process.exitCode=7"], { cwd: root, timeoutMs: 5_000 });
		expect(result).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 7, timedOut: false });
	});
	test("process timeout reaps even a child ignoring SIGTERM", async () => {
		const result = await runSelectionProcess("node", ["-e", "process.on('SIGTERM',()=>{}); console.log(process.pid);setInterval(()=>{},1000)"], { cwd: root, timeoutMs: 500, killGraceMs: 50 });
		expect(result.timedOut).toBe(true);
		const pid = Number(result.stdout.trim());
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	});
	test("spawn errors reject without waiting for timeout", async () => {
		await expect(runSelectionProcess(path.join(root, "missing-command"), [], { cwd: root, timeoutMs: 5_000 })).rejects.toThrow();
	});
});
