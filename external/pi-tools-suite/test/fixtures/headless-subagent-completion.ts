import { readFile } from "node:fs/promises";
import path from "node:path";

const RECORD_ENTRY = "pi-tools-suite:subagent";
const JOURNAL_FILE = "headless-parent.jsonl";

export type HeadlessRecord = Record<string, unknown> & { status?: string; exitCode?: number; finishedAt?: string };

/**
 * Fold the headless parent journal (`<scope>/headless-parent.jsonl`) for one
 * agent of the batch named by the run key `<cwd>/.pi/subagents/<scope>/<batch>`.
 */
export async function readHeadlessRecord(runDir: string, agentId: string): Promise<HeadlessRecord | undefined> {
	const batch = path.basename(runDir);
	const text = await readFile(path.join(path.dirname(runDir), JOURNAL_FILE), "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	let record: HeadlessRecord | undefined;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: string; customType?: string; data?: Record<string, unknown> };
		try { entry = JSON.parse(line); } catch { continue; }
		const data = entry.data;
		if (entry.type !== "custom" || entry.customType !== RECORD_ENTRY || data?.batch !== batch || data.agentId !== agentId) continue;
		record ??= {};
		for (const [name, value] of Object.entries(data)) {
			if (value === null) delete record[name];
			else if (value !== undefined) record[name] = value;
		}
	}
	return record;
}

/** Durable receipt: final outcome recorded and no retry pending. */
export function headlessReceipt(record: HeadlessRecord | undefined): string | undefined {
	if (!record?.finishedAt || record.status === "retrying") return undefined;
	if (record.status === "stopped") return "stopped";
	return typeof record.exitCode === "number" ? String(record.exitCode) : undefined;
}

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
		const record = await readHeadlessRecord(runDir, agentId);
		const receipt = headlessReceipt(record);
		latest = await status();
		if (receipt !== undefined && ["done", "failed", "stopped"].includes(latest)) return latest;
		if (Date.now() >= deadline) {
			const batch = path.basename(runDir);
			const cwd = path.dirname(path.dirname(path.dirname(path.dirname(runDir))));
			const brokerLog = await readFile(path.join(cwd, ".pi/artifacts/subagents", `${batch}-headless-broker.log`), "utf8").catch(() => "missing");
			throw new Error(`Subagent ${agentId} did not finalize: status=${latest}, receipt=${receipt ?? "missing"}, runDir=${runDir}\n`
				+ `record: ${JSON.stringify(record ?? null).slice(0, 2000)}\nheadless-broker.log: ${brokerLog.slice(-2000)}`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
	}
}
