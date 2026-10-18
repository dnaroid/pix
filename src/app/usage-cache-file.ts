import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Private, disposable, versioned snapshots. Callers own validation and diagnostics. */
export async function readUsageCache<T>(path: string, validate: (value: unknown) => value is T, maxBytes: number): Promise<T | undefined> {
	let file;
	try {
		file = await open(path, "r");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		if ((await file.stat()).size > maxBytes) throw new Error("OversizedUsageCache");
		const raw: unknown = JSON.parse(await file.readFile("utf8"));
		if (!raw || typeof raw !== "object" || !("version" in raw) || raw.version !== 1 || !("data" in raw) || !validate(raw.data)) {
			throw new Error("InvalidUsageCache");
		}
		return raw.data;
	} finally {
		await file.close();
	}
}

export async function writeUsageCache(path: string, data: unknown, maxBytes: number): Promise<void> {
	const text = JSON.stringify({ version: 1, data });
	if (Buffer.byteLength(text) > maxBytes) throw new Error("OversizedUsageCache");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}
