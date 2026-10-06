import { constants } from "node:fs";
import { lstat, open, realpath, readdir, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function checkedPath(value) {
	if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f]/u.test(value)
		|| value.split(/[\\/]/u).includes("..")) throw new Error("invalid or traversing path");
	return resolve(value);
}

export function contained(root, path) {
	const rel = relative(root, path);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Root is already canonical; forbid symlink components underneath it. */
export async function safePath(root, value, kind) {
	const path = checkedPath(value);
	if (path !== root && !contained(root, path)) throw new Error("path escapes its owned root");
	let cursor = root;
	for (const part of relative(root, path).split(sep).filter(Boolean)) {
		cursor = join(cursor, part);
		if ((await lstat(cursor)).isSymbolicLink()) throw new Error("symlink paths are not allowed");
	}
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || (kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) {
		throw new Error("unexpected file type");
	}
	return path;
}

export async function boundedRead(path, maxBytes = 4096) {
	const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await fd.stat();
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("input file exceeds limit or is not regular");
		const buffer = Buffer.alloc(maxBytes + 1);
		let count = 0;
		while (count < buffer.length) {
			const { bytesRead } = await fd.read(buffer, count, buffer.length - count, null);
			if (!bytesRead) break;
			count += bytesRead;
		}
		if (count > maxBytes) throw new Error("input file exceeds limit");
		return buffer.subarray(0, count);
	} finally { await fd.close(); }
}

export async function readJson(path, maxBytes = 4096) {
	try { return JSON.parse((await boundedRead(path, maxBytes)).toString("utf8")); }
	catch (error) {
		if (error.code) throw error;
		// Do not include JSON parser excerpts: seed inputs may contain secrets.
		throw new Error("invalid or oversized JSON input");
	}
}

export async function privateJson(path, value) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, path);
}

export async function ownedRoot(checkout, path) {
	const root = checkedPath(path);
	const bases = [join(checkout, ".pi", "subagents"), join(checkout, ".pi", "artifacts")];
	if (!bases.some((base) => contained(base, root))) throw new Error("run directory must be under this checkout's .pi/subagents or .pi/artifacts");
	await safePath(checkout, root, "directory");
	return root;
}

export async function createRun(checkout, requested) {
	const path = requested ? checkedPath(requested) : join(checkout, ".pi", "subagents", `qa-desktop-${randomUUID()}`);
	const bases = [join(checkout, ".pi", "subagents"), join(checkout, ".pi", "artifacts")];
	if (!bases.some((base) => contained(base, path))) throw new Error("--run-dir must be a new directory under .pi/subagents or .pi/artifacts");
	let cursor = checkout;
	for (const part of relative(checkout, dirname(path)).split(sep)) {
		cursor = join(cursor, part);
		await mkdir(cursor, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
		await safePath(checkout, cursor, "directory");
	}
	await mkdir(path, { mode: 0o700 }); // Never reuse someone else's run, even if empty.
	return realpath(path);
}

/** Watch bundles are immutable once published. Reject links/special files and bound traversal. */
export async function validateBundle(bundle, deadline = Infinity, now = Date.now) {
	let entries = 0;
	let bytes = 0;
	async function visit(path) {
		if (now() >= deadline) throw new Error("bundle snapshot deadline exceeded");
		const stat = await lstat(path);
		if (++entries > 50000 || (bytes += stat.size) > 2 * 1024 ** 3) throw new Error("bundle exceeds snapshot limits");
		if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error("bundle contains symlink or special file");
		if (stat.isDirectory()) for (const entry of await readdir(path)) await visit(join(path, entry));
	}
	await visit(bundle);
	const executable = join(bundle, "Contents", "MacOS", "pix-desktop");
	const stat = await lstat(executable);
	if (!stat.isFile() || !(stat.mode & 0o111) || !stat.size) throw new Error("bundle lacks executable pix-desktop");
	await safePath(bundle, join(bundle, "Contents", "Info.plist"), "file");
	return executable;
}
