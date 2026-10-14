import { logPixEvent, type PixLogContext } from "../logger.js";

/** Explicit handled-error boundary; never serialize arbitrary thrown request/payload objects. */
export function logOperationFailure(event: string, error: unknown, context: PixLogContext): void {
	try {
		const cancelled = error instanceof Error && error.name === "AbortError";
		logPixEvent(cancelled ? "debug" : "error", event,
			{ error: error instanceof Error ? error : "Non-Error failure", ...(cancelled ? { cancelled: true } : {}) }, context);
	} catch { /* Logging must not change the operation's outcome. */ }
}
