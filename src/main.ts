import { parseArgs } from "./app/cli/cli.js";
import { PiUiExtendApp } from "./app/app.js";
import { stringifyUnknown } from "./app/message-content.js";

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const app = new PiUiExtendApp(options);
	await app.start();
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : stringifyUnknown(error));
	process.exitCode = 1;
});
