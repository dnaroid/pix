// Sub-agent state lives in sessions (decision 0072): each child session under
// `.pi/subagents/<parent scope>/*.jsonl` starts with a `subagent_meta` entry,
// and the parent session holds folded `pi-tools-suite:subagent` records.
// This module never writes either file.
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { CouncilError } from "./storage.mjs";

const META_ENTRY = "subagent_meta";
const RECORD_ENTRY = "pi-tools-suite:subagent";
const SCOPE_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_BATCH = /^[A-Za-z0-9._-]+$/;
const META_HEAD_BYTES = 64 * 1024;

/** A council batch is a bare async-subagents batch name, never a path. */
export function assertBatchName(value) {
	if (typeof value !== "string" || !SAFE_BATCH.test(value) || value.includes("..")) {
		throw new CouncilError("Participant batch must be a bare sub-agent batch name");
	}
	return value;
}

async function readHead(file) {
	let handle;
	try { handle = await open(file, "r"); }
	catch { return ""; }
	try {
		const buffer = Buffer.alloc(META_HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

function metaFromHead(head) {
	for (const line of head.split("\n")) {
		if (!line.includes(META_ENTRY)) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type === "custom" && entry.customType === META_ENTRY && entry.data?.version === 1) return entry.data;
	}
	return undefined;
}

/** Newest child session of `agentId` in `batch`, or undefined before its first flush. */
export async function findChildSession(cwd, batch, agentId) {
	const root = path.join(await realpath(cwd), ".pi", "subagents");
	let scopes;
	try { scopes = await readdir(root, { withFileTypes: true }); }
	catch { return undefined; }
	let best;
	for (const scope of scopes) {
		if (!scope.isDirectory() || !SCOPE_DIR.test(scope.name)) continue;
		const dir = path.join(root, scope.name);
		let files;
		try { files = await readdir(dir, { withFileTypes: true }); }
		catch { continue; }
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
			const full = path.join(dir, file.name);
			const meta = metaFromHead(await readHead(full));
			if (meta?.batch !== batch || meta.agentId !== agentId) continue;
			const mtimeMs = (await stat(full).catch(() => undefined))?.mtimeMs ?? 0;
			if (!best || mtimeMs > best.mtimeMs) best = { file: full, meta, mtimeMs };
		}
	}
	return best;
}

/** Fold the parent-session record of one agent; `entries` changes on every update. */
export async function readParentRecord(parentSession, meta) {
	if (typeof parentSession !== "string" || !path.isAbsolute(parentSession) || !parentSession.endsWith(".jsonl")) return undefined;
	let text;
	try { text = await readFile(parentSession, "utf8"); }
	catch { return undefined; }
	let record;
	let entries = 0;
	for (const line of text.split("\n")) {
		if (!line.includes(RECORD_ENTRY)) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		const data = entry?.type === "custom" && entry.customType === RECORD_ENTRY ? entry.data : undefined;
		if (!data || data.version !== 1 || data.batch !== meta.batch || data.agentId !== meta.agentId) continue;
		if (meta.scope !== undefined && data.scope !== meta.scope) continue;
		record ??= {};
		for (const [key, value] of Object.entries(data)) {
			if (value === null) delete record[key];
			else record[key] = value;
		}
		entries++;
	}
	return record ? { record, entries } : undefined;
}

function assistantText(content) {
	if (typeof content === "string") return content.trim() ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
	return text.trim() ? text : undefined;
}

/**
 * User messages persisted in the participant's own session (live follow-ups
 * included) and its last successful assistant answer.
 */
export async function readChildSession(file) {
	let userMessages = 0;
	let lastText;
	for (const line of (await readFile(file, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		let entry;
		try { entry = JSON.parse(line); } catch { continue; }
		if (entry?.type !== "message") continue;
		if (entry.message?.role === "user") userMessages++;
		else if (entry.message?.role === "assistant" && entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted") {
			const text = assistantText(entry.message.content);
			if (text) lastText = text;
		}
	}
	return { userMessages, lastText };
}
