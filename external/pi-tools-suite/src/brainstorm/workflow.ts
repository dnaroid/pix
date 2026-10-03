import { randomUUID } from "node:crypto";
import path from "node:path";
import { makeTasks, roundName } from "./prompts.js";
import { assertMode, type BrainstormMode } from "./modes.js";
import { defaultBrainstormConfig, mergeBrainstormConfig, type BrainstormConfig } from "./config.js";
import { assertBoundedText, createRunDirectory, MAX_DOCUMENT_CHARS, replaceDocument, safeTopicSlug, writeExclusive, writeManifest } from "./storage.js";

export type { BrainstormConfig } from "./config.js";

export type BrainstormRound = 1 | 2 | 3 | 4 | 5;
export type BrainstormStatus = "running" | "awaiting_synthesis" | "reviewing_synthesis" | "awaiting_finalization" | "incomplete" | "complete";
export interface BrainstormTask { id: string; model: string; task: string; thinking: string; timeoutSeconds: number }
export interface BrainstormResponse { id: string; model: string; text: string }
export interface RunRoundInput { round: BrainstormRound; tasks: BrainstormTask[]; signal?: AbortSignal }
export type RunRound = (input: RunRoundInput) => Promise<BrainstormResponse[]>;
export interface BrainstormManifest {
	format: "pi-brainstorm-v3";
	mode: BrainstormMode;
	id: string;
	topic: string;
	brief: string;
	config: BrainstormConfig;
	createdAt: string;
	status: BrainstormStatus;
	models: string[];
	rounds: Partial<Record<BrainstormRound, BrainstormResponse[]>>;
	draftSha256?: string;
	error?: string;
}

export interface RunBrainstormResult {
	mode: BrainstormMode;
	runDir: string;
	status: "awaiting_synthesis" | "incomplete";
	models: string[];
	discussionPath: string;
	proposalPath: string;
}

export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Brainstorm cancelled", "AbortError");
}

export function validateResponses(raw: unknown, tasks: BrainstormTask[]): BrainstormResponse[] {
	if (!Array.isArray(raw)) throw new Error("Round callback must return an array of responses");
	const expected = new Map(tasks.map(({ id, model }) => [id, model]));
	const seen = new Set<string>();
	for (const item of raw) {
		if (!item || typeof item !== "object") throw new Error("Invalid round response");
		const response = item as BrainstormResponse;
		if (!expected.has(response.id)) throw new Error(`Unexpected response ID: ${String(response.id)}`);
		if (seen.has(response.id)) throw new Error(`Duplicate response ID: ${response.id}`);
		seen.add(response.id);
		if (response.model !== expected.get(response.id)) throw new Error(`Response model mismatch for ${response.id}`);
		assertBoundedText(response.text, `Response ${response.id}`, 40_000);
	}
	for (const id of expected.keys()) if (!seen.has(id)) throw new Error(`Missing response ID: ${id}`);
	if (raw.reduce((total, item) => total + (item as BrainstormResponse).text.length, 0) > MAX_DOCUMENT_CHARS) throw new Error("Round output exceeds the total document size limit");
	return raw as BrainstormResponse[];
}

function renderRound(mode: BrainstormMode, round: BrainstormRound, responses: BrainstormResponse[]): string {
	return `## Round ${round}: ${roundName(mode, round)}\n\n${responses.map((r) => `### ${r.id} — ${r.model}\n\n${r.text}`).join("\n\n---\n\n")}\n`;
}

export function renderDiscussion(manifest: BrainstormManifest): string {
	const rounds = Object.entries(manifest.rounds)
		.map(([round, responses]) => renderRound(manifest.mode, Number(round) as BrainstormRound, responses)).join("\n");
	const reviewLinks = manifest.draftSha256
		? "Round 5 reviews [the preserved draft](draft-proposal.md). Final changes: [revision notes](revision-notes.md), available after finalization.\n"
		: "";
	const failure = manifest.error ? `\n## Execution status: incomplete\n\n${manifest.error}\n` : "";
	return `# Discussion\n\nExecution status: see manifest.json\n\nMode: ${manifest.mode}\n\nModels: ${manifest.models.join(", ")}\n\n${rounds}\n${reviewLinks}${failure}`;
}

export async function collectRound(input: { manifest: BrainstormManifest; round: BrainstormRound; runRound: RunRound; signal?: AbortSignal; draft?: string }): Promise<void> {
	const { manifest, round, signal } = input;
	checkAbort(signal);
	const tasks = makeTasks({ mode: manifest.mode, topic: manifest.topic, brief: manifest.brief, models: manifest.models, round, rounds: manifest.rounds, draft: input.draft, thinking: manifest.config.thinking, timeoutSeconds: manifest.config.timeoutSeconds });
	const raw = await input.runRound({ round, tasks, signal });
	checkAbort(signal);
	const responses = validateResponses(raw, tasks);
	const priorOutput = Object.values(manifest.rounds).flat().reduce((total, response) => total + response.text.length, 0);
	if (priorOutput + responses.reduce((total, response) => total + response.text.length, 0) > MAX_DOCUMENT_CHARS) throw new Error("Brainstorm output exceeds the total document size limit");
	manifest.rounds[round] = responses;
}

export async function markIncomplete(runDir: string, manifest: BrainstormManifest, error: unknown): Promise<void> {
	manifest.status = "incomplete";
	manifest.error = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
	await replaceDocument(path.join(runDir, "discussion.md"), renderDiscussion(manifest)).catch(() => undefined);
	await writeManifest(path.join(runDir, "manifest.json"), manifest).catch(() => undefined);
}

export async function runBrainstorm(input: { cwd: string; topic: string; brief: string; mode?: BrainstormMode; config: BrainstormConfig; signal?: AbortSignal; runRound: RunRound }): Promise<RunBrainstormResult> {
	assertBoundedText(input.topic, "Topic", 2_000);
	assertBoundedText(input.brief, "Brief", 12_000);
	const mode = input.mode === undefined ? "brainstorm" : input.mode;
	assertMode(mode);
	const config = mergeBrainstormConfig(defaultBrainstormConfig(), input.config);
	checkAbort(input.signal);
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const { runDir } = await createRunDirectory(input.cwd, input.topic, id);
	const briefPath = path.join(runDir, "brief.md");
	const discussionPath = path.join(runDir, "discussion.md");
	const proposalPath = path.join(runDir, "proposal.md");
	const manifestPath = path.join(runDir, "manifest.json");
	const manifest: BrainstormManifest = { format: "pi-brainstorm-v3", mode, id, topic: input.topic, brief: input.brief, config, createdAt: new Date().toISOString(), status: "running", models: [...config.models], rounds: {} };
	try {
		checkAbort(input.signal);
		await writeExclusive(briefPath, `# Council brief\n\n${input.brief}\n\n## Execution\n\n- Mode: ${mode}\n- Topic: ${input.topic}\n- Date: ${manifest.createdAt.slice(0, 10)}\n- Requested models: ${config.models.join(", ")}\n- Thinking: ${config.thinking}\n- Timeout per participant per round: ${config.timeoutSeconds}s\n- Rounds: ${([1, 2, 3, 4, 5] as const).map((round) => roundName(mode, round)).join(" → ")}. Parent draft before round 5; parent finalization after review. No implementation.\n`);
		checkAbort(input.signal);
		await writeExclusive(discussionPath, renderDiscussion(manifest));
		checkAbort(input.signal);
		await writeExclusive(proposalPath, `# ${safeTopicSlug(input.topic)}\n\nStatus: **pending synthesis**\n\nThis file is a placeholder. No synthesis has been performed.\n`);
		checkAbort(input.signal);
		await writeManifest(manifestPath, manifest);
		checkAbort(input.signal);
		for (const round of [1, 2, 3, 4] as const) {
			await collectRound({ manifest, round, runRound: input.runRound, signal: input.signal });
			await replaceDocument(discussionPath, renderDiscussion(manifest));
			checkAbort(input.signal);
			await writeManifest(manifestPath, manifest);
			checkAbort(input.signal);
		}
		manifest.status = "awaiting_synthesis";
		await writeManifest(manifestPath, manifest);
		checkAbort(input.signal);
		return { mode, runDir, status: "awaiting_synthesis", models: [...config.models], discussionPath, proposalPath };
	} catch (error) {
		await markIncomplete(runDir, manifest, error);
		return { mode, runDir, status: "incomplete", models: [...config.models], discussionPath, proposalPath };
	}
}
