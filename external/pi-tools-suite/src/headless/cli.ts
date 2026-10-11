#!/usr/bin/env node
import { createHeadlessToolApi, type HeadlessModel } from "./api.js";

type Request = {
	operation: "list" | "call";
	cwd: string;
	tool?: string;
	args?: unknown;
	readOnly?: boolean;
	model?: HeadlessModel;
};

/** One request per process. Base64url avoids shell quoting and accidental command injection. */
async function main(): Promise<void> {
	const encoded = process.argv[2];
	if (!encoded || encoded.length > 256_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
		throw new Error("Usage: headless/cli.ts <base64url JSON request>");
	}
	const request = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Request;
	if (request?.operation !== "list" && request?.operation !== "call") throw new Error("Invalid headless operation");
	if (typeof request.cwd !== "string" || !request.cwd || !request.cwd.startsWith("/")) throw new Error("Absolute cwd required");
	if (request.readOnly === false && !process.argv.includes("--allow-write")) {
		throw new Error("Write mode requires the explicit --allow-write CLI flag");
	}
	const api = await createHeadlessToolApi({ cwd: request.cwd, readOnly: request.readOnly, model: request.model });
	if (request.operation === "list") {
		process.stdout.write(`${JSON.stringify({ ok: true, ...api.inventory() })}\n`);
		return;
	}
	if (typeof request.tool !== "string" || !request.tool) throw new Error("Missing tool name");
	const result = await api.execute(request.tool, request.args ?? {});
	process.stdout.write(`${JSON.stringify({ ok: !result.isError, result })}\n`);
}

main().catch((error: unknown) => {
	process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
	process.exitCode = 1;
});
