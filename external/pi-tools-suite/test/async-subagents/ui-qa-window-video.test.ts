import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { maybeStartWindowVideoRecorder } from "../../src/async-subagents/agents/ui-qa/backends/desktop.mjs";
import { removeDirsWithRetry } from "../support/fs-retry.js";

const tempDirs: string[] = [];
afterEach(async () => { await removeDirsWithRetry(tempDirs); });

describe("native window video policy", () => {
	test("disables the producer before helper access, even with recording capability", async () => {
		for (const supportedCapabilities of [["windowVideo"], []]) {
			const observations: unknown[] = [];
			const helper = new Proxy({}, { get() { throw new Error("disabled recorder touched helper"); } });
			const recorder = await maybeStartWindowVideoRecorder({
				context: { flow: { recordWindowVideo: false } },
				helper, selector: ["--pid", "123"], observations, probe: { supportedCapabilities },
			});
			expect(recorder).toBeNull();
			expect(observations).toEqual([{ action: "windowVideo", status: "disabled", reason: "flow.recordWindowVideo is false" }]);
		}
	});

	test("omission and true retain best-effort recording rather than silently disabling it", async () => {
		for (const flow of [{}, { recordWindowVideo: true }]) {
			const observations: unknown[] = [];
			let producerChecks = 0;
			const helper = {
				label: "test driver",
				get supportsWindowVideo() { producerChecks += 1; return false; },
			};
			await maybeStartWindowVideoRecorder({
				context: { flow }, helper, selector: [], observations,
				probe: { supportedCapabilities: ["windowVideo"] },
			});
			expect(producerChecks).toBe(1);
			expect(observations).toEqual([expect.objectContaining({ action: "windowVideo", status: "unavailable", reason: "test driver does not implement exact-window video recording" })]);
		}
	});

	test("keeps missing capability distinct from opt-out", async () => {
		const observations: unknown[] = [];
		await maybeStartWindowVideoRecorder({ context: { flow: {} }, helper: null, selector: [], observations, probe: { supportedCapabilities: [] } });
		expect(observations).toEqual([expect.objectContaining({ action: "windowVideo", status: "unavailable" })]);
	});

	test("rejects malformed or unsupported policy before probing or launching", () => {
		const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-video-policy-")));
		tempDirs.push(project);
		const agentDir = path.join(project, ".pi", "artifacts", "subagents", "video-policy");
		const flows = path.join(agentDir, "ui-qa", "flows");
		fs.mkdirSync(flows, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(agentDir, "project_cwd"), project, { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "subagent_type"), "ui-qa", { mode: 0o600 });
		const runner = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs");
		const cases = [
			{ target: { application: { pid: 123 } }, recordAppAudio: "true", reason: "recordAppAudio must be a boolean" },
			{ target: { application: { pid: 123 } }, recordAppAudio: true, recordWindowVideo: false, reason: "recordAppAudio requires window video" },
			{ target: { url: "https://example.invalid" }, recordAppAudio: true, reason: "recordAppAudio is supported only for non-fixture desktop applications" },
			...["false", 0, null, {}].map((recordWindowVideo) => ({ target: { application: { pid: 123 } }, recordWindowVideo, reason: "recordWindowVideo must be a boolean" })),
			...[{ url: "https://example.invalid" }, { command: { argv: ["not-executed"] } }].map((target) => ({ target, recordWindowVideo: false, reason: "recordWindowVideo is supported only for desktop and native-terminal targets" })),
		];
		for (const { reason, ...flow } of cases) {
			fs.writeFileSync(path.join(flows, "invalid.jsonc"), JSON.stringify(flow), { mode: 0o600 });
			const result = spawnSync("node", [runner, "probe", "--flow", "invalid.jsonc"], {
				cwd: project, env: { ...process.env, PI_SUBAGENT_AGENT_DIR: agentDir }, encoding: "utf8", timeout: 10_000,
			});
			expect(result.status).toBe(1);
			expect(JSON.parse(result.stdout.trim())).toMatchObject({ status: "FAILED", reason });
			expect(fs.existsSync(path.join(agentDir, "evidence"))).toBe(false);
		}
	});
});
