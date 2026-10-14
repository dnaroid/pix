import { parseArgs } from "./app/cli/cli.js";
import { PiUiExtendApp } from "./app/app.js";
import { stringifyUnknown } from "./app/rendering/message-content.js";
import { installPixProcessLogging, pixLogger } from "./app/logger.js";

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	installPixProcessLogging({ project: options.cwd, module: "process" });
	const app = new PiUiExtendApp(options);
	try { await app.start(); }
	catch (error) {
		await pixLogger.log("error", "process:fatal", { error }, { project: options.cwd, module: "process" });
		throw error;
	}
}

main().catch(async (error: unknown) => {
	console.error(error instanceof Error ? error.message : stringifyUnknown(error));
	process.exitCode = 1;
});
