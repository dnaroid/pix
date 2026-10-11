#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { assertHeadlessSubagentSpawn, createHeadlessToolApi, type HeadlessModel } from "./api.js";
import { launchSubagentsBroker, runSubagentsBroker } from "./subagent-broker.js";

type Request = {
	operation: "list" | "call";
	cwd: string;
	tool?: string;
	args?: unknown;
	readOnly?: boolean;
	model?: HeadlessModel;
	todoSessionKey?: string;
	todoStateDirectory?: string;
};

/** One request per process. Base64url avoids shell quoting and accidental command injection. */
async function main(): Promise<void> {
	const encoded = process.argv[2];
	if (!encoded || encoded.length > 256_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
		throw new Error("Usage: headless/cli.ts <base64url JSON request>");
	}
	const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Request;
	if (request?.operation !== "list" && request?.operation !== "call") throw new Error("Invalid headless operation");
	if (typeof request.cwd !== "string" || !isAbsolute(request.cwd)) throw new Error("Absolute cwd required");
	if (request.readOnly === false && !process.argv.includes("--allow-write")) {
		throw new Error("Write mode requires the explicit --allow-write CLI flag");
	}
	const api = await createHeadlessToolApi({
		cwd: request.cwd,
		readOnly: request.readOnly,
		projectTaskWrites: request.readOnly === false,
		model: request.model,
		...(request.todoSessionKey ? {
			todoSession: { key: request.todoSessionKey, directory: request.todoStateDirectory },
		} : {}),
	});
	if (request.operation === "list") {
		process.stdout.write(`${JSON.stringify({ ok: true, ...api.inventory() })}\n`);
		return;
	}
	if (typeof request.tool !== "string" || !request.tool) throw new Error("Missing tool name");
	const cancelled = new AbortController();
	const stop = () => cancelled.abort(new Error("Headless operation interrupted"));
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	try {
		const spawnAgents = request.tool === "subagents" && (request.args as { action?: unknown } | undefined)?.action === "spawn";
		if (spawnAgents) assertHeadlessSubagentSpawn(request.args);
		if (spawnAgents && (request.args as { watchSeconds?: unknown }).watchSeconds !== undefined
			&& (request.args as { watchSeconds?: unknown }).watchSeconds !== 0) {
			throw new Error("Headless spawn does not support watchSeconds; use subagents(action=wait) after spawn");
		}
		if (process.argv.includes("--broker")) {
			const index = process.argv.indexOf("--broker");
			const responseFile = process.argv[index + 1];
			if (!spawnAgents || !responseFile || request.readOnly !== false) throw new Error("Invalid Pix broker invocation");
			await runSubagentsBroker(api, { ...(request.args as Record<string, unknown>), watchSeconds: 0 }, responseFile);
			return;
		}
		const result = spawnAgents && request.readOnly === false
			? await launchSubagentsBroker(encoded, request.cwd, cancelled.signal)
			: await api.execute(request.tool, request.args ?? {}, cancelled.signal);
		// Tool-level isError is still a valid protocol response. Do not replace
		// the original Pix diagnostic with a generic subprocess failure.
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
	}
}

main().catch((error: unknown) => {
	process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exitCode = 1;
});
