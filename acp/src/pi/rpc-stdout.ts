import type { ChildProcess } from "node:child_process";
import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { attachJsonlReader } from "./jsonl-reader.js";

/**
 * Pi 1.4.0's stdout reader repeatedly scans/copies the entire unfinished line.
 * Image-heavy get_messages/get_entries replies therefore take quadratic work.
 * Keep SDK parsing, correlation and timeouts; replace only its stream framing.
 *
 * Compatibility seam: start() synchronously spawns and attaches the SDK reader
 * before its first await. Replace it in the SAME turn, before stdout can flow;
 * awaiting start() first could discard a partial startup event. Recheck these
 * private fields and that startup ordering on SDK upgrades (integration-tested).
 */
export async function startRpcClient(client: RpcClient): Promise<void> {
	const starting = client.start();
	try {
		const internals = client as unknown as {
			process?: ChildProcess | null;
			stopReadingStdout?: (() => void) | null;
			handleLine?: (line: string) => void;
		};
		const stdout = internals.process?.stdout;
		const handleLine = internals.handleLine;
		if (!stdout || typeof internals.stopReadingStdout !== "function" || typeof handleLine !== "function") {
			throw new Error("Unsupported Pi RPC stdout reader; recheck SDK startup compatibility");
		}
		internals.stopReadingStdout();
		internals.stopReadingStdout = attachJsonlReader(stdout, (line) => handleLine.call(client, line));
		await starting;
	} catch (error) {
		// Observe startup rejection even if compatibility checking failed first.
		await starting.catch(() => {});
		await client.stop();
		throw error;
	}
}
