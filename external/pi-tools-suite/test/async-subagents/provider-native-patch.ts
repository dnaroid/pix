// Explicit, anchored, test-only replacement artifact. Never edits the source snapshot.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export function applyNativeProviderPatch(staged: string): void {
	const path = join(staged, "src/claude-process.ts");
	let source = readFileSync(path, "utf8");
	const replacements: Array<[string, string]> = [
		['import { spawn, type ChildProcess } from "node:child_process";', 'import { type ChildProcess } from "node:child_process";\nimport { nativeSpawn, nativeSupervisor } from "./provider-native-adapter.ts";'],
		['  const child = spawn(launch.command, launch.args, {', '  const child = nativeSpawn(options.env?.PI_PROVIDER_TEST_NATIVE_RELAY ?? process.env.PI_PROVIDER_TEST_NATIVE_RELAY!, launch.command, launch.args, {'],
		['    detached: process.platform !== "win32",\n    windowsHide: process.platform === "win32",\n    stdio: [options.stdin, "pipe", "pipe"],\n', '    stdin: options.stdin,\n'],
		['  const supervisor = options.supervise(child, {', '  const supervisor = nativeSupervisor(child, {'],
		['    onFailure: (error) => options.onFailure(vanishedExecutable(error, options.installation.executable) ?? error),\n  });', '    onFailure: (error) => options.onFailure(vanishedExecutable(error, options.installation.executable) ?? error),\n  }, options.supervise);'],
	];
	for (const [before, after] of replacements) {
		if (source.split(before).length !== 2) throw new Error(`Non-unique native provider patch anchor: ${before.slice(0, 80)}`);
		source = source.replace(before, after);
	}
	writeFileSync(path, source);
	copyFileSync(join(here, "provider-native-adapter.ts"), join(staged, "src/provider-native-adapter.ts"));
}
