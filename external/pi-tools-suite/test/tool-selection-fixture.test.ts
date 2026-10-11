import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeToolSelectionFixture } from "./tool-selection-fixture.js";
import { resolveEvalOutputDir } from "./evals/harness/output-dir.js";
import { findProjectRoot } from "../src/lib/project.js";
import { loadPiToolsSuiteConfig } from "../src/config.js";
import { runSelectionProcess } from "./tool-selection-process.js";

const root = resolveEvalOutputDir("tool-selection-contracts");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("tool-selection fixture contracts", () => {
	test("native source fixture owns its repository root and knowledge source", () => {
		const dir = makeToolSelectionFixture(root);
		expect(findProjectRoot(path.join(dir, "src"))).toBe(dir);
		expect(fs.readFileSync(path.join(dir, "specs", "payment-retry.md"), "utf8")).toContain("kind: spec");
		const config = loadPiToolsSuiteConfig([], { cwd: dir, includeUserConfig: false, env: {} });
		expect(config.disabledBuiltinAgents).toContain("knowledge-auditor");
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
