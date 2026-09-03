/**
 * Adapter configuration resolved from environment variables.
 *
 * Environment:
 *   PIX_ACP_PI_ENTRY     path to the Node-readable pi RPC entry module
 *                        (default: package-exported bundled rpc-entry)
 *   PIX_ACP_PI_BIN       deprecated alias for PIX_ACP_PI_ENTRY
 *   PIX_ACP_LOG          log level: debug | info | warn | error (default: info)
 *   PIX_ACP_SESSION_MAP  path to the ACP↔pi session map file
 *                        (default: ~/.pi/agent/pix-acp/sessions.json)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLogLevel, type LogLevel } from "./logging.js";

export function defaultPiEntryPath(): string {
	return fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));
}

export function defaultSessionMapPath(): string {
	return join(homedir(), ".pi", "agent", "pix-acp", "sessions.json");
}

export interface AdapterConfig {
	readonly piEntry: string;
	readonly logLevel: LogLevel;
	readonly sessionMapPath: string;
}

export interface AdapterConfigInput {
	readonly piEntry?: string | undefined;
	readonly logLevel?: string | undefined;
	readonly sessionMapPath?: string | undefined;
}

export function resolveAdapterConfig(input: AdapterConfigInput = {}): AdapterConfig {
	return {
		piEntry: input.piEntry?.trim() ? input.piEntry.trim() : defaultPiEntryPath(),
		logLevel: parseLogLevel(input.logLevel),
		sessionMapPath: input.sessionMapPath?.trim() ? input.sessionMapPath.trim() : defaultSessionMapPath(),
	};
}

export function adapterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
	return resolveAdapterConfig({
		piEntry: env["PIX_ACP_PI_ENTRY"] ?? env["PIX_ACP_PI_BIN"],
		logLevel: env["PIX_ACP_LOG"],
		sessionMapPath: env["PIX_ACP_SESSION_MAP"],
	});
}
