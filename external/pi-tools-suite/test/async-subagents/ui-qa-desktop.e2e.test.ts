import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const RUN_E2E = process.platform === "darwin" && /^(1|true|yes)$/i.test(process.env.UI_QA_DESKTOP_E2E ?? "");
const e2eTest = RUN_E2E ? test : test.skip;
const runner = path.resolve(import.meta.dir, "../../src/async-subagents/agents/ui-qa/scripts/ui-qa-runner.mjs");
const fixtureSource = path.resolve(import.meta.dir, "../fixtures/ui-qa/macos-accessibility-fixture.swift");

e2eTest("macOS desktop backend semantically activates a real AppKit control", () => {
	const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-desktop-e2e-")));
	try {
		const agentDir = path.join(project, ".pi", "subagents", "run", "qa");
		const uiWorkspace = path.join(agentDir, "ui-qa");
		fs.mkdirSync(path.join(uiWorkspace, "flows"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(agentDir, "browser-qa", "flows"), { recursive: true, mode: 0o700 });
		for (const directory of [path.join(project, ".pi"), path.join(project, ".pi", "subagents"), path.join(project, ".pi", "subagents", "run"), agentDir, uiWorkspace, path.join(uiWorkspace, "flows"), path.join(agentDir, "browser-qa"), path.join(agentDir, "browser-qa", "flows")]) fs.chmodSync(directory, 0o700);
		fs.writeFileSync(path.join(agentDir, "prompt.md"), "QA prompt\n", { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "project_cwd"), `${project}\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "subagent_type"), "ui-qa\n", { mode: 0o600 });

		const executable = path.join(project, "accessibility-fixture");
		const compile = spawnSync("xcrun", ["swiftc", "-O", fixtureSource, "-o", executable], { encoding: "utf8", timeout: 120_000 });
		expect(compile.status, compile.stderr).toBe(0);
		fs.chmodSync(executable, 0o700);
		const flow = {
			version: 1,
			target: { application: { launch: { argv: ["./accessibility-fixture"] } } },
			steps: [
				{ action: "waitForWindow", timeoutMs: 15_000 },
				{ action: "assertText", text: "Count: 0" },
				{ action: "assertState", selector: { name: "Increment", role: "Button" }, attribute: "enabled", equals: true },
				{ action: "activate", selector: { name: "Increment", role: "Button" } },
				{ action: "waitForText", text: "Count: 1" },
				{ action: "assertText", text: "Count: 1" },
				{ action: "capture", name: "incremented" },
			],
		};
		const flowPath = path.join(uiWorkspace, "flows", "desktop.jsonc");
		fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2), { mode: 0o600 });
		const execution = spawnSync("node", [runner, "run", "--flow", "desktop.jsonc", "--run-id", "desktop-e2e", "--runner-timeout-ms", "60000"], {
			cwd: project,
			env: { ...process.env, PI_SUBAGENT_AGENT_DIR: agentDir },
			encoding: "utf8",
			timeout: 90_000,
			maxBuffer: 2 * 1024 * 1024,
		});
		const outputLines = execution.stdout.trim().split(/\r?\n/);
		const payload = JSON.parse(outputLines[outputLines.length - 1] ?? "{}");
		expect(execution.status, `${payload.reason ?? ""}\n${execution.stderr}`).toBe(0);
		expect(payload.status).toBe("PASSED");
		expect(payload.selection.selectedBackend).toBe("desktop");
		expect(payload.assertions.every((assertion: any) => assertion.passed)).toBe(true);
		expect(payload.artifacts.accessibilitySnapshots.length).toBeGreaterThan(0);
		expect(payload.artifacts.screenshots.length).toBeGreaterThan(0);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
}, 120_000);

e2eTest("macOS desktop backend records exact-window video concurrently with the flow", () => {
	const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ui-qa-video-e2e-")));
	try {
		const agentDir = path.join(project, ".pi", "subagents", "run", "qa");
		const uiWorkspace = path.join(agentDir, "ui-qa");
		fs.mkdirSync(path.join(uiWorkspace, "flows"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(agentDir, "browser-qa", "flows"), { recursive: true, mode: 0o700 });
		for (const directory of [path.join(project, ".pi"), path.join(project, ".pi", "subagents"), path.join(project, ".pi", "subagents", "run"), agentDir, uiWorkspace, path.join(uiWorkspace, "flows"), path.join(agentDir, "browser-qa"), path.join(agentDir, "browser-qa", "flows")]) fs.chmodSync(directory, 0o700);
		fs.writeFileSync(path.join(agentDir, "prompt.md"), "QA prompt\n", { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "project_cwd"), `${project}\n`, { mode: 0o600 });
		fs.writeFileSync(path.join(agentDir, "subagent_type"), "ui-qa\n", { mode: 0o600 });

		const executable = path.join(project, "accessibility-fixture");
		const compile = spawnSync("xcrun", ["swiftc", "-O", fixtureSource, "-o", executable], { encoding: "utf8", timeout: 120_000 });
		expect(compile.status, compile.stderr).toBe(0);
		fs.chmodSync(executable, 0o700);
		const durationMs = 30_000;
		const flow = {
			version: 1,
			target: { application: { launch: { argv: ["./accessibility-fixture"] } } },
			steps: [
				{ action: "waitForWindow", timeoutMs: 15_000 },
				{ action: "assertText", text: "Count: 0" },
				{ action: "activate", selector: { name: "Increment", role: "Button" } },
				{ action: "waitForText", text: "Count: 1" },
				{ action: "assertText", text: "Count: 1" },
				{ action: "capture", name: "incremented" },
			],
		};
		const flowPath = path.join(uiWorkspace, "flows", "desktop.jsonc");
		fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2), { mode: 0o600 });
		const execution = spawnSync("node", [runner, "run", "--flow", "desktop.jsonc", "--run-id", "desktop-video", "--runner-timeout-ms", "60000"], {
			cwd: project,
			env: { ...process.env, PI_SUBAGENT_AGENT_DIR: agentDir },
			encoding: "utf8",
			timeout: 90_000,
			maxBuffer: 2 * 1024 * 1024,
		});
		const outputLines = execution.stdout.trim().split(/\r?\n/);
		const payload = JSON.parse(outputLines[outputLines.length - 1] ?? "{}");
		if (!payload.selection?.supportedCapabilities?.includes("windowVideo")) {
			// Missing recording permission/API only suppresses best-effort video;
			// deterministic accessibility assertions still decide the run.
			expect(execution.status, execution.stderr).toBe(0);
			expect(payload.status).toBe("PASSED");
			expect(payload.artifacts.videos).toHaveLength(0);
			expect(payload.observations).toContainEqual(expect.objectContaining({ action: "windowVideo", status: "unavailable" }));
			return;
		}
		expect(execution.status, `${payload.reason ?? ""}\n${execution.stderr}`).toBe(0);
		expect(payload.status).toBe("PASSED");
		expect(payload.artifacts.videos).toHaveLength(1);
		const video = payload.artifacts.videos[0];
		expect(video.format).toBe("mp4");
		expect(video.durationMs).toBeLessThanOrEqual(durationMs);
		expect(video.path.startsWith(path.join(project, ".pi", "subagents", "run", "qa", "ui-qa", "evidence", "desktop-video"))).toBe(true);
		const stat = fs.statSync(video.path);
		expect(stat.isFile()).toBe(true);
		expect(stat.size).toBeGreaterThan(0);
		expect(stat.mode & 0o777).toBe(0o600);
		const head = fs.readFileSync(video.path).subarray(0, 12);
		expect(head.subarray(4, 8).toString("latin1")).toBe("ftyp");
		// mvhd duration proves the recording captured flow activity, capped at 30s.
		const box = fs.readFileSync(video.path);
		const mvhd = box.indexOf("mvhd");
		expect(mvhd).toBeGreaterThan(0);
		const version = box[mvhd + 4];
		const timescale = version === 1 ? box.readUInt32BE(mvhd + 24) : box.readUInt32BE(mvhd + 16);
		const durationUnits = version === 1 ? Number(box.readBigUInt64BE(mvhd + 28)) : box.readUInt32BE(mvhd + 20);
		const recordedMs = Math.round((durationUnits / timescale) * 1000);
		expect(recordedMs).toBeGreaterThan(0);
		expect(recordedMs).toBeLessThanOrEqual(durationMs + 1_000);
		const recorded = payload.observations.find((entry: any) => entry.action === "windowVideo" && entry.status === "recorded");
		expect(recorded?.bytes).toBe(stat.size);
		// No partial temp files may survive a finalized run.
		const evidenceDir = path.dirname(video.path);
		expect(fs.readdirSync(evidenceDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
	} finally {
		fs.rmSync(project, { recursive: true, force: true });
	}
}, 150_000);
