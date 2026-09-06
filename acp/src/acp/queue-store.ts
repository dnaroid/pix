import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DesktopQueuedUserMessage } from "./desktop-commands.js";
import { tuiTabSnapshotPath } from "./tui-tabs.js";

export interface PersistedDesktopQueues {
	readonly auto: DesktopQueuedUserMessage[];
	readonly deferred: DesktopQueuedUserMessage[];
}

type MutableTab = Record<string, unknown> & {
	path: string;
	autoUserMessages?: DesktopQueuedUserMessage[];
	deferredUserMessages?: DesktopQueuedUserMessage[];
};

const EMPTY_QUEUES: PersistedDesktopQueues = { auto: [], deferred: [] };
const writeTails = new Map<string, Promise<void>>();
const INVALID_TAB_STATE = Symbol("invalid-tab-state");

export async function loadDesktopQueues(
	cwd: string,
	sessionPath: string | undefined,
	agentDir = getAgentDir(),
): Promise<PersistedDesktopQueues> {
	if (!sessionPath) return EMPTY_QUEUES;
	const parsed = await readTabState(cwd, agentDir);
	if (!parsed || parsed === INVALID_TAB_STATE) return EMPTY_QUEUES;
	const target = resolve(sessionPath);
	const tab = parsed.tabs.find((candidate) => resolve(candidate.path) === target);
	return tab ? queuesFromTab(tab) : EMPTY_QUEUES;
}

export function saveDesktopQueues(
	cwd: string,
	sessionPath: string | undefined,
	queues: PersistedDesktopQueues,
	agentDir = getAgentDir(),
): Promise<void> {
	if (!sessionPath) return Promise.resolve();
	const path = tuiTabSnapshotPath(cwd, agentDir);
	const previous = writeTails.get(path) ?? Promise.resolve();
	const write = previous.then(async () => {
		const loaded = await readTabState(cwd, agentDir);
		if (loaded === INVALID_TAB_STATE) {
			throw new Error("refusing to overwrite an invalid or unsupported Pix tab snapshot while saving the message queue");
		}
		const existing = loaded ?? {
			version: 4 as const,
			cwd: resolve(cwd),
			tabs: [] as MutableTab[],
		};
		const target = resolve(sessionPath);
		let tab = existing.tabs.find((candidate) => resolve(candidate.path) === target);
		if (!tab) {
			tab = { path: target };
			existing.tabs.push(tab);
		}

		if (queues.auto.length > 0) tab.autoUserMessages = queues.auto.map(cloneMessage);
		else delete tab.autoUserMessages;
		if (queues.deferred.length > 0) tab.deferredUserMessages = queues.deferred.map(cloneMessage);
		else delete tab.deferredUserMessages;

		existing.version = 4;
		existing.cwd = typeof existing.cwd === "string" ? existing.cwd : resolve(cwd);
		await mkdir(dirname(path), { recursive: true });
		const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify(existing, null, 2), "utf8");
		await rename(temp, path);
	}).finally(() => {
		if (writeTails.get(path) === write) writeTails.delete(path);
	});
	writeTails.set(path, write);
	return write;
}

async function readTabState(cwd: string, agentDir: string): Promise<{
	version: number;
	cwd?: string;
	activePath?: string;
	tabs: MutableTab[];
} | typeof INVALID_TAB_STATE | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(tuiTabSnapshotPath(cwd, agentDir), "utf8"));
		if (!isRecord(parsed) || ![1, 2, 3, 4].includes(Number(parsed.version)) || !Array.isArray(parsed.tabs)) {
			return INVALID_TAB_STATE;
		}
		const tabs = parsed.tabs.flatMap((value): MutableTab[] => (
			isRecord(value) && typeof value.path === "string" ? [{ ...value, path: value.path } as MutableTab] : []
		));
		return {
			version: Number(parsed.version),
			...(typeof parsed.cwd === "string" ? { cwd: parsed.cwd } : {}),
			...(typeof parsed.activePath === "string" ? { activePath: parsed.activePath } : {}),
			tabs,
		};
	} catch (error) {
		return isRecord(error) && error.code === "ENOENT" ? undefined : INVALID_TAB_STATE;
	}
}

function queuesFromTab(tab: MutableTab): PersistedDesktopQueues {
	return {
		auto: parseMessages(tab.autoUserMessages),
		deferred: parseMessages(tab.deferredUserMessages),
	};
}

function parseMessages(value: unknown): DesktopQueuedUserMessage[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate): DesktopQueuedUserMessage[] => {
		if (!isRecord(candidate) || typeof candidate.promptText !== "string" || typeof candidate.displayText !== "string") return [];
		const images = Array.isArray(candidate.images)
			? candidate.images.flatMap((image) => (
				isRecord(image) && image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string"
					? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }]
					: []
			))
			: [];
		return [{
			id: typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID(),
			promptText: candidate.promptText,
			displayText: candidate.displayText,
			images,
		}];
	});
}

function cloneMessage(message: DesktopQueuedUserMessage): DesktopQueuedUserMessage {
	return {
		id: message.id,
		promptText: message.promptText,
		displayText: message.displayText,
		images: message.images.map((image) => ({ ...image })),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
