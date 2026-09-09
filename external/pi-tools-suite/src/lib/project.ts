import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export function directoryExists(file: string): boolean {
	try {
		return existsSync(file) && statSync(file).isDirectory();
	} catch {
		return false;
	}
}

export function fileExists(file: string): boolean {
	try {
		return existsSync(file) && statSync(file).isFile();
	} catch {
		return false;
	}
}

export function findProjectRoot(cwd: string): string {
	let dir = path.resolve(cwd);
	let packageRoot: string | undefined;

	while (true) {
		if (directoryExists(path.join(dir, ".indexer-cli"))) return dir;
		if (directoryExists(path.join(dir, ".git"))) return dir;
		if (!packageRoot && fileExists(path.join(dir, "package.json"))) packageRoot = dir;

		const parent = path.dirname(dir);
		if (parent === dir) return packageRoot ?? path.resolve(cwd);
		dir = parent;
	}
}

export function findIndexedProjectRoot(cwd: string): string | undefined {
	const projectRoot = findProjectRoot(cwd);
	return directoryExists(path.join(projectRoot, ".indexer-cli")) ? projectRoot : undefined;
}

export function hasIndexedProjectRoot(cwd: string = process.cwd()): boolean {
	return findIndexedProjectRoot(cwd) !== undefined;
}

export function commandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
	const value = command.trim();
	if (!value || value.includes(path.sep)) return false;
	const pathValue = env.PATH ?? "";
	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) continue;
		try {
			accessSync(path.join(directory, value), constants.X_OK);
			return true;
		} catch {
			// Continue through PATH without spawning a process or blocking on shell lookup.
		}
	}
	return false;
}

export function hasAvailableIndexedProjectRoot(
	cwd: string = process.cwd(),
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return hasIndexedProjectRoot(cwd) && commandAvailable("idx", env);
}
