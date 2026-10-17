import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeadlessToolApi, HeadlessResult } from "./api.js";
import { PROJECT_ARTIFACTS_DIR } from "../artifact-paths.js";
import { runKnown } from "../async-subagents/core/lookup.js";
import { parseRunKey } from "../async-subagents/core/paths.js";
import { getLive, getRecord } from "../async-subagents/core/store.js";

type BrokerReply = { ok: true; result: HeadlessResult } | { ok: false; error: string };

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/**
 * Durable completion receipt of a scheduled agent: its parent-session record
 * has a final outcome (`finishedAt` + exit code or `stopped`), no pending
 * retry and no live process in this runtime (decision 0072).
 */
export function subagentCompletionReceipt(runDir: string, agentId: string): string | undefined {
	const record = getRecord(runDir, agentId);
	if (!record?.finishedAt || record.status === "retrying" || getLive(runDir, agentId)?.active) return undefined;
	if (record.status === "stopped") return "stopped";
	return typeof record.exitCode === "number" ? String(record.exitCode) : undefined;
}

/** Broker diagnostics live in `.pi/artifacts/subagents/<batch>-headless-broker.log`. */
function brokerLogFile(runDir: string): string {
	const parsed = parseRunKey(runDir);
	return path.join(parsed?.cwd ?? process.cwd(), PROJECT_ARTIFACTS_DIR, "subagents", `${parsed?.batch ?? path.basename(runDir)}-headless-broker.log`);
}

export async function writeSubagentsBrokerReply(
	file: string,
	payload: BrokerReply,
	write: typeof writeFile = writeFile,
): Promise<void> {
	// The CLI polls for existence. writeFile creates an empty destination before
	// writing JSON, so publish only after the same-directory write has closed.
	const pending = `${file}.pending`;
	try {
		await write(pending, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
		await rename(pending, file);
	} finally {
		// A failed success reply must not prevent publishing the error reply.
		await rm(pending, { force: true });
	}
}

/**
 * Spawn must outlive its initiating MCP call: the Pix suite owns live RPC pipes
 * and completion receipts in the process that launched its child agents.
 * A detached broker keeps that original Pix runtime alive until agents settle.
 */
export async function launchSubagentsBroker(
	encodedRequest: string,
	cwd: string,
	signal: AbortSignal,
): Promise<HeadlessResult> {
	const scratch = await mkdtemp(path.join(tmpdir(), "pix-subagents-broker-"));
	const file = path.join(scratch, "reply.json");
	const log = path.join(scratch, "broker.stderr.log");
	let proc: ReturnType<typeof spawn> | undefined;
	try {
		// Source CLI must use an ABSOLUTE tsx import. Inheriting `--import tsx`
		// would resolve from the *selected project* cwd, where tsx isn't installed.
		const loader = process.argv[1]?.endsWith(".ts")
			? ["--import", import.meta.resolve("tsx")] : [];
		const stderr = openSync(log, "a", 0o600);
		try {
			// Windows libuv assigns non-detached children to a kill-on-parent-exit
			// Job Object. unref() only releases the event-loop reference: it does
			// not let the broker survive the initiating CLI. Detach on every OS;
			// the broker still owns its agents and their RPC pipes until settlement.
			proc = spawn(process.execPath, [...loader, process.argv[1]!, encodedRequest, "--allow-write", "--broker", file], {
				cwd, env: process.env, detached: true, windowsHide: true, stdio: ["ignore", "ignore", stderr],
			});
		} finally {
			closeSync(stderr);
		}
		proc.unref();
		const started = Date.now();
		while (true) {
			signal.throwIfAborted();
			try {
				const response = JSON.parse(await readFile(file, "utf8")) as BrokerReply;
				if (!response.ok) throw new Error(response.error);
				return response.result;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (Date.now() - started > 45_000) {
				const diagnostic = await readFile(log, "utf8").catch(() => "");
				throw new Error(`Pix subagents broker did not acknowledge spawn within 45s: ${diagnostic.slice(-500)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Broker process entrypoint: actual Pix spawn + lifecycle ownership. */
export async function runSubagentsBroker(
	api: Pick<HeadlessToolApi, "execute">,
	params: unknown,
	file: string,
): Promise<void> {
	let result: HeadlessResult;
	try {
		result = await api.execute("subagents", params);
		await writeSubagentsBrokerReply(file, { ok: true, result });
	} catch (error) {
		await writeSubagentsBrokerReply(file, { ok: false, error: message(error) }).catch(() => {});
		return;
	}
	if (result.isError) return;
	const details = result.details as { runDir?: unknown; tasks?: Array<{ id: string }> } | undefined;
	if (typeof details?.runDir !== "string") return;
	const runDir = details.runDir;
	// `wait` is the original Pix tool and reads durable run artifacts. The broker
	// must not confuse its dead-PID `stopped` fallback with a final receipt.
	// In particular, Windows taskkill can release the last child/pipe handle
	// before Pix's UNREFERENCED drain/finalization timers commit the outcome.
	// Keep a referenced poll alive until every scheduled agent has both a
	// terminal state and a receipt, including when wait returns immediately.
	// IDs can be omitted or normalized by Pix. Its resolved task previews are
	// authoritative, including queued tasks missing from a transient status.
	const tasks = details.tasks ?? [];
	const logFile = brokerLogFile(runDir);
	const log = (text: string) => mkdir(path.dirname(logFile), { recursive: true })
		.then(() => appendFile(logFile, `${new Date().toISOString()}: broker_pid=${process.pid} ${text}\n`)).catch(() => {});
	let lastDiagnostic = "";
	while (true) {
		try {
			// External cleanup must not retain an otherwise idle broker forever.
			if (!runKnown(runDir)) return;
			// Read receipts BEFORE status. Otherwise a stopped snapshot can be
			// paired with a new failed receipt whose callback has already queued
			// a retry, causing us to abandon its unreferenced backoff timer.
			const receipts = tasks.map((task) => ({ task, receipt: subagentCompletionReceipt(runDir, task.id) }));
			const status = await api.execute("subagents", { action: "wait", runDir, timeout: 300, interval: 2 });
			const agents = (status.details as { agents?: Array<{ id: string; status: string }> } | undefined)?.agents ?? [];
			const pending = receipts.map(({ task, receipt }) => {
				const agent = agents.find((entry) => entry.id === task.id);
				if (receipt?.trim() && agent && ["done", "failed", "stopped"].includes(agent.status)) return undefined;
				return `${task.id}:status=${agent?.status ?? "missing"},exit_code=${receipt?.trim() || "missing"}`;
			});
			const outstanding = pending.filter((entry) => entry !== undefined);
			if (tasks.length > 0 && outstanding.length === 0) return;
			const diagnostic = `awaiting completion receipts: ${outstanding.join("; ") || "missing scheduled tasks"}`;
			if (diagnostic !== lastDiagnostic) { lastDiagnostic = diagnostic; await log(diagnostic); }
		} catch (error) {
			// A transient status/read failure must not abandon owned callbacks.
			const diagnostic = `completion poll failed: ${message(error)}`;
			if (diagnostic !== lastDiagnostic) { lastDiagnostic = diagnostic; await log(diagnostic); }
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}
