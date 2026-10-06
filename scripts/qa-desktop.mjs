import { fileURLToPath } from "node:url";
import { runCli } from "./qa-desktop/cli.mjs";

try {
	process.exitCode = await runCli(process.argv.slice(2), fileURLToPath(new URL("../", import.meta.url)));
} catch (error) {
	console.error(`qa:desktop: ${error.message}`);
	process.exitCode = 1;
}
