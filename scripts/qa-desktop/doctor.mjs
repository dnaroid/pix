import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareMacosHelper } from "../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/helper-cache.mjs";
import { bundledMacosHelper } from "../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/release-helper.mjs";

const SOURCE = fileURLToPath(new URL("../../external/pi-tools-suite/src/async-subagents/agents/ui-qa/drivers/macos/macos-accessibility.swift", import.meta.url));

function runCommand(file, args, { cwd, timeoutMs }) {
	return new Promise((resolve) => {
		execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
			resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr: stderr || error?.message || "" });
		});
	});
}

/** Host setup only: installs/verifies the same helper used by the runner, never opens Desktop. */
export async function doctorDesktop({ checkout, prompt = false }, dependencies = {}) {
	const { run = runCommand, prepare = prepareMacosHelper, bundled = bundledMacosHelper, now = Date.now } = dependencies;
	const deadline = now() + 90_000;
	const context = { projectRoot: checkout, source: SOURCE, deadline, run };
	// Preserve release precedence and fail closed for damaged release payloads.
	const helperPath = await bundled(context) ?? await prepare(context);
	if (now() >= deadline) throw new Error("macOS helper preparation timed out");
	const result = await run(helperPath, prompt === true ? ["doctor", "--prompt"] : ["doctor"], {
		cwd: checkout, timeoutMs: Math.max(1, Math.min(30_000, deadline - now())),
	});
	if (result.code !== 0) throw new Error(result.stderr || `macOS helper doctor exited ${result.code}`);
	const output = result.stdout.trim();
	const accessibility = /(?:^|\n)accessibility=(granted|missing)(?:\n|$)/u.exec(output)?.[1];
	const screenRecording = /(?:^|\n)screen_recording=(granted|missing)(?:\n|$)/u.exec(output)?.[1];
	if (!accessibility || !screenRecording) throw new Error("macOS helper returned invalid permission status");
	return { helperPath, output, code: accessibility === "granted" && screenRecording === "granted" ? 0 : 2 };
}
