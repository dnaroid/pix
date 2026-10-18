import * as fs from "node:fs";
import * as path from "node:path";
import { PROJECT_ARTIFACTS_DIR } from "../../artifact-paths.js";
import { parseRunKey, validateBasename } from "./paths.js";

/** Resume reuses this identity: never delete evidence or flows from prior turns. */
export function prepareUiQaWorkspace(cwd: string, runDir: string, agentId: string): string {
	fs.mkdirSync(cwd, { recursive: true });
	const project = fs.realpathSync(cwd);
	const batch = parseRunKey(runDir)?.batch ?? path.basename(runDir);
	validateBasename(batch, "QA batch");
	validateBasename(agentId, "QA agent");
	const root = path.join(project, PROJECT_ARTIFACTS_DIR, "subagents", `${batch}-${agentId}`);
	// Do not follow links into another project or allow evidence-directory swaps.
	let current = project;
	for (const part of path.relative(project, root).split(path.sep)) {
		current = path.join(current, part);
		ensureDirectory(current, false);
	}
	for (const [name, value] of [["project_cwd", `${project}\n`], ["subagent_type", "ui-qa\n"]]) {
		const file = path.join(root, name);
		if (fs.existsSync(file) || isSymlink(file)) {
			const stat = fs.lstatSync(file);
			if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(file, "utf8") !== value) throw new Error("QA workspace identity mismatch");
		} else fs.writeFileSync(file, value, { mode: 0o600, flag: "wx" });
	}
	const workspace = path.join(root, "ui-qa");
	for (const dir of [workspace, path.join(workspace, "flows"), path.join(workspace, "browser"), path.join(workspace, "browser", "flows")]) ensureDirectory(dir, true);
	return root;
}

function isSymlink(file: string): boolean {
	try { return fs.lstatSync(file).isSymbolicLink(); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function ensureDirectory(dir: string, privateDirectory: boolean): void {
	if (!fs.existsSync(dir) && !isSymlink(dir)) fs.mkdirSync(dir, { mode: 0o700 });
	const stat = fs.lstatSync(dir);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("QA workspace must contain only real directories");
	if (privateDirectory && process.platform !== "win32" && (stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}
