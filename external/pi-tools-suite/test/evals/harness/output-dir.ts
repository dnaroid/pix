import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { PROJECT_ARTIFACTS_DIR } from "../../../src/artifact-paths.js";

/** Resolve from the caller's project, never from the installed suite location. */
export function resolveEvalOutputDir(prefix: string, override?: string, cwd = process.cwd()): string {
	if (override) return path.resolve(cwd, override);
	let root = path.resolve(cwd);
	while (!existsSync(path.join(root, ".pi")) && !existsSync(path.join(root, ".git"))) {
		const parent = path.dirname(root);
		if (parent === root) {
			root = path.resolve(cwd);
			break;
		}
		root = parent;
	}
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	return path.join(root, PROJECT_ARTIFACTS_DIR, "evals", `${prefix}-${stamp}-${randomUUID()}`);
}
