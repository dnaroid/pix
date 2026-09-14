import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Make idx discoverable for tests that intentionally exercise repo_* tools. */
export function installFakeIdxOnPath(root: string): () => void {
	const binDir = path.join(root, ".test-bin");
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		writeFileSync(path.join(binDir, "idx.cmd"), "@echo off\r\nexit /b 0\r\n");
	} else {
		writeFileSync(path.join(binDir, "idx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	}

	const previousPath = process.env.PATH;
	process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
	return () => {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	};
}
