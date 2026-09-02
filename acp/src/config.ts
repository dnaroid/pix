/**
 * Adapter configuration resolved from environment variables.
 *
 * Environment:
 *   PIX_ACP_PI_BIN       path to the `pi` CLI to spawn in RPC mode (default: "pi")
 *   PIX_ACP_LOG          log level: debug | info | warn | error (default: info)
 *   PIX_ACP_SESSION_MAP  path to the ACP↔pi session map file
 *                        (default: ~/.pi/agent/pix-acp/sessions.json)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { parseLogLevel, type LogLevel } from "./logging.js";

export function defaultSessionMapPath(): string {
	return join(homedir(), ".pi", "agent", "pix-acp", "sessions.json");
}

export interface AdapterConfig {
	readonly piBinary: string;
	readonly logLevel: LogLevel;
	readonly sessionMapPath: string;
}

export interface AdapterConfigInput {
	readonly piBinary?: string | undefined;
	readonly logLevel?: string | undefined;
	readonly sessionMapPath?: string | undefined;
}

export function resolveAdapterConfig(input: AdapterConfigInput = {}): AdapterConfig {
	return {
		piBinary: input.piBinary?.trim() ? input.piBinary.trim() : "pi",
		logLevel: parseLogLevel(input.logLevel),
		sessionMapPath: input.sessionMapPath?.trim() ? input.sessionMapPath.trim() : defaultSessionMapPath(),
	};
}

export function adapterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
	return resolveAdapterConfig({
		piBinary: env["PIX_ACP_PI_BIN"],
		logLevel: env["PIX_ACP_LOG"],
		sessionMapPath: env["PIX_ACP_SESSION_MAP"],
	});
}
