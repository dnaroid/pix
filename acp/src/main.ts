/**
 * pix-acp entry point: ACP agent over stdio.
 *
 * stdout carries the ACP JSON-RPC protocol stream — never write to it.
 * All diagnostics go to stderr via the logger.
 */

import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { PixAcpAgent } from "./acp/pix-acp-agent.js";
import { adapterConfigFromEnv } from "./config.js";
import { acpFileLogger, createLogger } from "./logging.js";
import { installPixProcessLogging } from "../../dist/app/logger.js";
import { PiRpcClient } from "./pi/pi-rpc-client.js";
import { stringifyUnknown } from "./stringify-unknown.js";

/** Compiled beside main.js in dist; the .ts source when run through tsx. */
function wikiConflictsExtensionPath(): string | undefined {
	for (const name of ["wiki-conflicts.js", "wiki-conflicts.ts"]) {
		const path = fileURLToPath(new URL(`./extensions/${name}`, import.meta.url));
		if (existsSync(path)) return path;
	}
	return undefined;
}

async function main(): Promise<void> {
	installPixProcessLogging({ module: "acp-process" }, acpFileLogger);
	const config = adapterConfigFromEnv();
	const logger = createLogger(config.logLevel);
	const wikiConflicts = wikiConflictsExtensionPath();

	const adapter = new PixAcpAgent({
		createPiClient: (options) => new PiRpcClient(options),
		piEntry: config.piEntry,
		logger,
		sessionMapPath: config.sessionMapPath,
		...(config.questionExtensionPath ? { questionExtensionPath: config.questionExtensionPath } : {}),
		...(config.sessionTitleExtensionPath ? { sessionTitleExtensionPath: config.sessionTitleExtensionPath } : {}),
		...(config.workspaceUndoExtensionPath ? { workspaceUndoExtensionPath: config.workspaceUndoExtensionPath } : {}),
		...(config.toolsSuiteExtensionPath ? { toolsSuiteExtensionPath: config.toolsSuiteExtensionPath } : {}),
		...(config.quotaWaitExtensionPath ? { quotaWaitExtensionPath: config.quotaWaitExtensionPath } : {}),
		...(config.headsUpExtensionPath ? { headsUpExtensionPath: config.headsUpExtensionPath } : {}),
		...(config.htmlSandboxExtensionPath ? { htmlSandboxExtensionPath: config.htmlSandboxExtensionPath } : {}),
		...(wikiConflicts ? { wikiConflictsExtensionPath: wikiConflicts } : {}),
	});

	const stream = ndJsonStream(
		Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
		Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
	);
	const connection = adapter.connect(stream);
	logger.info(`pix-acp ready on stdio (pi entry: ${config.piEntry})`);

	await connection.closed;
	await adapter.dispose();
	logger.info("connection closed; exiting");
	await acpFileLogger.flush();
}

main().catch(async (error: unknown) => {
	createLogger().error(`fatal: ${stringifyUnknown(error)}`);
	await acpFileLogger.flush();
	process.exitCode = 1;
});
