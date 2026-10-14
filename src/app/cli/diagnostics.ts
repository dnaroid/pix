import { pixLogger } from "../logger.js";
import { logOperationFailure } from "../logging/operation-errors.js";

/** CLI commands may be followed immediately by process.exit in bin/pix.mjs. */
export async function withCliDiagnostics(command: string, operation: () => Promise<number>): Promise<number> {
	try {
		return await operation();
	} catch (error) {
		logOperationFailure(`${command}:failed`, error, { project: null, module: `cli.${command}` });
		throw error;
	} finally {
		await pixLogger.flush();
	}
}
