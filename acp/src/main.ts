/**
 * pix-acp entry point: ACP agent over stdio.
 *
 * stdout carries the ACP JSON-RPC protocol stream — never write to it.
 * All diagnostics go to stderr via the logger.
 */

import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { PixAcpAgent } from "./acp/pix-acp-agent.js";
import { adapterConfigFromEnv } from "./config.js";
import { createLogger } from "./logging.js";
import { PiRpcClient } from "./pi/pi-rpc-client.js";
import { stringifyUnknown } from "./stringify-unknown.js";

async function main(): Promise<void> {
	const config = adapterConfigFromEnv();
	const logger = createLogger(config.logLevel);

	const adapter = new PixAcpAgent({
		createPiClient: (options) => new PiRpcClient(options),
		piBinary: config.piBinary,
		logger,
		sessionMapPath: config.sessionMapPath,
	});

	const stream = ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	);
	const connection = adapter.connect(stream);
	logger.info(`pix-acp ready on stdio (pi binary: ${config.piBinary})`);

	await connection.closed;
	await adapter.dispose();
	logger.info("connection closed; exiting");
}

main().catch((error: unknown) => {
	process.stderr.write(`[pix-acp] fatal: ${stringifyUnknown(error)}\n`);
	process.exitCode = 1;
});
