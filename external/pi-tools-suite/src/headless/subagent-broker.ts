import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HeadlessToolApi, HeadlessResult } from "./api.js";

type BrokerReply = { ok: true; result: HeadlessResult } | { ok: false; error: string };

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

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
			proc = spawn(process.execPath, [...loader, process.argv[1]!, encodedRequest, "--allow-write", "--broker", file], {
				cwd, env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "ignore", stderr],
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
	api: HeadlessToolApi,
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
	const details = result.details as { runDir?: unknown } | undefined;
	if (typeof details?.runDir !== "string") return;
	const runDir = details.runDir;
	// `wait` is the original Pix tool and reads durable run artifacts. The broker
	// keeps all live spawn completion handlers, pipes and timeouts alive.
	try {
		while (true) {
			const status = await api.execute("subagents", { action: "wait", runDir, timeout: 300, interval: 2 });
			const agents = (status.details as { agents?: Array<{ status: string }> } | undefined)?.agents;
			if (!agents?.some((agent) => ["planned", "running", "retrying"].includes(agent.status))) break;
		}
	} catch (error) {
		await appendFile(path.join(runDir, "headless-broker.log"), `${new Date().toISOString()}: ${message(error)}\n`).catch(() => {});
	}
}
