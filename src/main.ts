import { parseArgs } from "./app/cli/cli.js";
import { installPixProcessLogging, pixLogger, routePixNodeWarnings } from "./app/logger.js";

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const scope = { project: options.cwd, module: "process" };
	routePixNodeWarnings(scope);
	installPixProcessLogging(scope);
	const { PiUiExtendApp } = await import("./app/app.js");
	const app = new PiUiExtendApp(options);
	try { await app.start(); }
	catch (error) {
		await pixLogger.log("error", "process:fatal", { error }, scope);
		throw error;
	}
}

main().catch(async (error: unknown) => {
	if (error instanceof Error) console.error(error.message);
	else {
		const { stringifyUnknown } = await import("./app/rendering/message-content.js");
		console.error(stringifyUnknown(error));
	}
	process.exitCode = 1;
});
