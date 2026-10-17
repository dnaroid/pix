import { readFile } from "node:fs/promises";
import path from "node:path";

/** Wait for the detached broker's final receipt, not just a dead child PID. */
export async function waitForHeadlessSubagentCompletion(
	runDir: string,
	agentId: string,
	status: () => Promise<string>,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<string> {
	const deadline = Date.now() + (options.timeoutMs ?? 30_000);
	let latest = "missing";
	while (true) {
		// Read the receipt before status: a child can be dead while its broker
		// is still draining stdout or waiting for the completion fallback timer.
		const receipt = await readFile(path.join(runDir, agentId, "exit_code"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		latest = await status();
		if (receipt !== undefined && ["done", "failed", "stopped"].includes(latest)) return latest;
		if (Date.now() >= deadline) {
			const diagnostics = await Promise.all([
				["headless-broker.log", path.join(runDir, "headless-broker.log")],
				...["pid", "stderr.log", "progress.jsonl", "result.md"].map((file) => [file, path.join(runDir, agentId, file)]),
			].map(async ([label, file]) => `${label}: ${(await readFile(file!, "utf8").catch(() => "missing")).slice(-2000)}`));
			throw new Error(`Subagent ${agentId} did not finalize: status=${latest}, exit_code=${receipt ?? "missing"}, runDir=${runDir}\n${diagnostics.join("\n")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
	}
}
