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
