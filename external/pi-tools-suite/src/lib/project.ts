import { existsSync, statSync } from "node:fs";
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
		if (directoryExists(path.join(dir, ".git")) || fileExists(path.join(dir, ".git"))) return dir;
		if (!packageRoot && fileExists(path.join(dir, "package.json"))) packageRoot = dir;

		const parent = path.dirname(dir);
		if (parent === dir) return packageRoot ?? path.resolve(cwd);
		dir = parent;
	}
}
