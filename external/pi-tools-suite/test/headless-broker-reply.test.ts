import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { writeSubagentsBrokerReply } from "../src/headless/subagent-broker.js";

const artifacts = path.resolve(import.meta.dir, "../../../.pi/artifacts");

async function readIfPresent(file: string): Promise<string | undefined> {
	return readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return undefined;
		throw error;
	});
}

test("broker reply is invisible until the whole JSON acknowledgment is written", async () => {
	await mkdir(artifacts, { recursive: true });
	const scratch = await mkdtemp(path.join(artifacts, "headless-reply-"));
	const file = path.join(scratch, "reply.json");
	let opened!: () => void;
	let release!: () => void;
	const created = new Promise<void>((resolve) => { opened = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	const pausedWrite: typeof writeFile = async (target, data, options) => {
		await writeFile(target, "", options);
		opened();
		await released;
		await writeFile(target, data);
	};
	const payload = { ok: true as const, result: { content: [{ type: "text" as const, text: "spawned" }] } };
	const publication = writeSubagentsBrokerReply(file, payload, pausedWrite);
	try {
		await Promise.race([created, publication]);
		const visibleBeforeWrite = await readIfPresent(file);
		release();
		await publication;
		expect(visibleBeforeWrite).toBeUndefined();
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual(payload);
	} finally {
		release();
		await publication.catch(() => {});
		await rm(scratch, { recursive: true, force: true });
	}
});

test("failed broker reply publication leaves no partial acknowledgment and can publish its error", async () => {
	await mkdir(artifacts, { recursive: true });
	const scratch = await mkdtemp(path.join(artifacts, "headless-reply-"));
	const file = path.join(scratch, "reply.json");
	const failedWrite: typeof writeFile = async (target, _data, options) => {
		await writeFile(target, "", options);
		throw new Error("controlled write failure");
	};
	try {
		await expect(writeSubagentsBrokerReply(file, { ok: false, error: "spawn failed" }, failedWrite))
			.rejects.toThrow("controlled write failure");
		expect(await readIfPresent(file)).toBeUndefined();
		await writeSubagentsBrokerReply(file, { ok: false, error: "controlled write failure" });
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: false, error: "controlled write failure" });
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
});
