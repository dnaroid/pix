import { RequestError } from "@agentclientprotocol/sdk";
import { withPixLogContext, type Logger } from "../logging.js";

type RequestLogContext = { project: string | null; sessionId?: string; module: string };

/** Observe handled RPC failures without changing their identity or recording params/error data. */
export function withLoggedRequest<T>(logger: Logger, method: string, context: RequestLogContext,
	signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
	return withPixLogContext(context, async () => {
		try {
			return await operation();
		} catch (error) {
			reportRequestFailure(logger, method, error, signal, context);
			throw error;
		}
	});
}

export function reportRequestFailure(logger: Logger, method: string, error: unknown,
	signal: AbortSignal, context?: RequestLogContext): void {
	// Diagnostics must never replace an RPC error, even with an injected/broken sink.
	try {
		const code = error instanceof RequestError ? error.code : undefined;
		const cancelled = signal.aborted || code === -32800 || (error instanceof Error && error.name === "AbortError");
		if (cancelled) {
			logger.debug(`request:cancelled ${method}`, context);
		} else if (code === -32600 || code === -32601 || code === -32602) {
			// Validation messages/data can echo prompt text, paths or arbitrary caller input.
			logger.warn(`request:rejected ${method} code=${code}`, context);
		} else {
			const message = error instanceof Error ? error.message : "Non-Error failure";
			logger.error(`request:failed ${method}${code === undefined ? "" : ` code=${code}`}: ${message}`, context);
		}
	} catch { /* Best effort only. */ }
}
