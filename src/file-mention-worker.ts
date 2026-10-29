import { parentPort, workerData } from "node:worker_threads";
import { watch } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import { fuzzySearch } from "./fuzzy.js";
import type { FileMentionMatch } from "./file-mentions.js";

const cwd = (workerData as { cwd: string }).cwd;
const entries = new Map<string, FileMentionMatch>();
const rules = new Map<string, Ignore>();
const port = parentPort!;
const portable = (path: string) => path.split(sep).join("/");

function skipUnavailable(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	if (code === "ENOENT") return true;
	if (code !== "EACCES" && code !== "EPERM") return false;
	port.postMessage({ warning: String(error) });
	return true;
}

async function readRules(directory: string): Promise<void> {
	try { rules.set(directory, ignore().add(await readFile(join(cwd, directory, ".gitignore"), "utf8"))); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		rules.delete(directory);
	}
}

function ignored(path: string, directory: boolean): boolean {
	if (path.split("/").includes(".git")) return true;
	let parent = portable(dirname(path));
	const ancestors: string[] = [];
	while (true) {
		ancestors.unshift(parent);
		if (parent === "." || parent === "") break;
		parent = portable(dirname(parent));
	}
	let excluded = false;
	for (const ancestor of ancestors) {
		const local = portable(relative(ancestor || ".", path)) + (directory ? "/" : "");
		const result = rules.get(ancestor === "." ? "" : ancestor)?.test(local);
		if (result?.ignored) excluded = true;
		if (result?.unignored) excluded = false;
	}
	return excluded;
}

async function scan(directory: string): Promise<void> {
	await readRules(directory);
	for (const entry of await readdir(join(cwd, directory), { withFileTypes: true })) {
		const path = directory ? `${directory}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()) || ignored(path, entry.isDirectory())) continue;
		entries.set(path, { path: path + (entry.isDirectory() ? "/" : ""), directory: entry.isDirectory() });
		if (entry.isDirectory()) {
			try { await scan(path); } catch (error) {
				if (!skipUnavailable(error)) throw error;
			}
		}
	}
}

function remove(path: string): void {
	for (const key of entries.keys()) if (key === path || key.startsWith(`${path}/`)) entries.delete(key);
	for (const key of rules.keys()) if (key === path || key.startsWith(`${path}/`)) rules.delete(key);
}

async function rebuild(): Promise<void> {
	entries.clear(); rules.clear(); await scan("");
}

function ignoredAncestor(path: string): boolean {
	const parent = portable(dirname(path));
	return parent !== "." && parent !== "" && ignored(parent, true);
}

async function update(paths: Set<string>): Promise<void> {
	if ([...paths].some((path) => (path === ".gitignore" || path.endsWith("/.gitignore")) && !ignoredAncestor(path))) {
		await rebuild(); return;
	}
	for (const path of paths) {
		remove(path);
		try {
			const stat = await lstat(join(cwd, path));
			if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || ignored(path, stat.isDirectory())) continue;
			entries.set(path, { path: path + (stat.isDirectory() ? "/" : ""), directory: stat.isDirectory() });
			if (stat.isDirectory()) await scan(path);
		} catch (error) { if (!skipUnavailable(error)) throw error; }
	}
}

// Install before scanning: changes during a scan are serialized after it, never lost.
let work = scan("");
let stale = false;
// Keep initial failures observed until a query can report them to its caller.
void work.catch(() => {});
let changed = new Set<string>();
let timer: ReturnType<typeof setTimeout> | undefined;
try {
	const watcher = watch(cwd, { recursive: true }, (_event, filename) => {
		if (!filename) return;
		const path = portable(filename.toString());
		if (path.split("/").includes(".git") || ignoredAncestor(path)) return;
		changed.add(path);
		// A fixed coalescing window cannot be starved by a continuous build/install.
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			const paths = changed; changed = new Set();
			work = work.then(async () => {
				if (stale) { await rebuild(); stale = false; }
				else await update(paths);
			}).catch((error: unknown) => { stale = true; port.postMessage({ warning: String(error) }); });
		}, 100);
	});
	watcher.on("error", (error) => port.postMessage({ warning: error.message }));
} catch (error) { port.postMessage({ warning: String(error) }); }

const pending = new Set<number>();
port.on("message", ({ id, query, cancel }: { id: number; query: string; cancel?: boolean }) => {
	if (cancel) { pending.delete(id); return; }
	pending.add(id);
	// A failed update never becomes a silently partial index for subsequent queries.
	work = work.then(async () => { if (stale) { await rebuild(); stale = false; } });
	void work.then(() => {
		if (!pending.has(id)) return;
		const matches = fuzzySearch([...entries.values()].map((value) => ({
			value, label: value.path, aliases: [value.path.replace(/\/$/, "").split("/").at(-1) ?? value.path],
		})), query, { limit: 20, includeEmptyQuery: true }).map((match) => match.value);
		pending.delete(id);
		port.postMessage({ id, matches });
	}).catch((error: unknown) => {
		if (pending.delete(id)) port.postMessage({ id, error: String(error) });
	});
});
