import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { makeTasks, participantSlot, roundName } from "./prompts.js";
import { assertMode, type BrainstormMode } from "./modes.js";
import { assertRunnableConfig, defaultBrainstormConfig, mergeBrainstormConfig, resolvedQuorum, thinkingForModel, type BrainstormConfig, type BrainstormConfigInput } from "./config.js";
import { renderPositionMatrix, scriptWarnings } from "./ledger.js";
import { assertBoundedText, createRunDirectory, MAX_DOCUMENT_CHARS, replaceDocument, safeTopicSlug, writeExclusive, writeJson } from "./storage.js";

export type { BrainstormConfig } from "./config.js";

export type BrainstormRound = 1 | 2 | 3 | 4 | 5;
export type BrainstormStatus = "running" | "awaiting_synthesis" | "reviewing_synthesis" | "awaiting_finalization" | "incomplete" | "complete";
export interface BrainstormTask { id: string; model: string; task: string; thinking: string; timeoutSeconds: number }
export interface BrainstormResponse { id: string; model: string; text: string; source?: string }
export interface MissingParticipant { id: string; model: string; reason: string }
/** A runner may return only responses (all required) or declare missing participants for the quorum check. */
export interface RoundOutcome { responses: BrainstormResponse[]; missing?: MissingParticipant[] }
export type BrainstormExecution = "desktop-sessions";
export interface RunRoundInput { round: BrainstormRound; tasks: BrainstormTask[]; signal?: AbortSignal; runId?: string; runDir?: string; topic?: string; execution?: BrainstormExecution }
export type TerminalNotification = (runId: string, status: "complete" | "incomplete") => Promise<void>;
export interface RunRound {
	(input: RunRoundInput): Promise<BrainstormResponse[] | RoundOutcome>;
	execution?: BrainstormExecution;
	/** Check continuation compatibility before writing the draft or changing state. */
	validateExecution?: (execution: BrainstormExecution | undefined) => void;
	onTerminal?: TerminalNotification;
}

/** Response text lives in rounds/<id>.md; the manifest keeps only provenance and integrity data. */
export interface StoredResponse { id: string; model: string; file: string; sha256: string; chars: number; source?: string; warnings?: string[] }
export const MANIFEST_FORMAT = "pi-brainstorm-v4";
export interface BrainstormManifest {
	format: typeof MANIFEST_FORMAT;
	mode: BrainstormMode;
	id: string;
	topic: string;
	brief: string;
	config: BrainstormConfig;
	createdAt: string;
	status: BrainstormStatus;
	models: string[];
	rounds: Partial<Record<BrainstormRound, StoredResponse[]>>;
	missing?: Partial<Record<BrainstormRound, MissingParticipant[]>>;
	draftSha256?: string;
	publishedPath?: string;
	error?: string;
	/** Absent on legacy/TUI runs: use fresh nested subagents, never silently switch. */
	execution?: BrainstormExecution;
}
/** Manifest plus loaded response texts. */
export interface RunState { manifest: BrainstormManifest; texts: Partial<Record<BrainstormRound, BrainstormResponse[]>> }

export interface RunBrainstormResult {
	mode: BrainstormMode;
	runDir: string;
	status: "awaiting_synthesis" | "incomplete";
	models: string[];
	discussionPath: string;
	proposalPath: string;
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Brainstorm cancelled", "AbortError");
}

/**
 * Exact attribution for every response; participants absent from the responses
 * must be declared missing, and the remaining responses must reach the quorum.
 */
export function validateResponses(raw: unknown, tasks: Array<Pick<BrainstormTask, "id" | "model">>, quorum = tasks.length): { responses: BrainstormResponse[]; missing: MissingParticipant[] } {
	const outcome = Array.isArray(raw) ? { responses: raw, missing: [] as unknown[] } : raw && typeof raw === "object" ? raw as { responses?: unknown; missing?: unknown } : undefined;
	if (!outcome || !Array.isArray(outcome.responses) || (outcome.missing !== undefined && !Array.isArray(outcome.missing))) throw new Error("Round callback must return an array of responses");
	const expected = new Map(tasks.map(({ id, model }) => [id, model]));
	const seen = new Set<string>();
	for (const item of outcome.responses as unknown[]) {
		if (!item || typeof item !== "object") throw new Error("Invalid round response");
		const response = item as BrainstormResponse;
		if (!expected.has(response.id)) throw new Error(`Unexpected response ID: ${String(response.id)}`);
		if (seen.has(response.id)) throw new Error(`Duplicate response ID: ${response.id}`);
		seen.add(response.id);
		if (response.model !== expected.get(response.id)) throw new Error(`Response model mismatch for ${response.id}`);
		assertBoundedText(response.text, `Response ${response.id}`, 40_000);
	}
	const missing: MissingParticipant[] = [];
	for (const item of (outcome.missing ?? []) as unknown[]) {
		const entry = item as MissingParticipant;
		if (!entry || typeof entry !== "object" || !expected.has(entry.id) || entry.model !== expected.get(entry.id) || seen.has(entry.id) || missing.some((other) => other.id === entry.id)) {
			throw new Error(`Invalid missing-participant entry: ${String(entry?.id)}`);
		}
		missing.push({ id: entry.id, model: entry.model, reason: String(entry.reason ?? "unknown").slice(0, 500) });
	}
	for (const id of expected.keys()) if (!seen.has(id) && !missing.some((entry) => entry.id === id)) throw new Error(`Missing response ID: ${id}`);
	if (seen.size < Math.min(quorum, tasks.length)) {
		throw new Error(`Round quorum not met: ${seen.size}/${tasks.length} responses, ${quorum} required (${missing.map((entry) => `${entry.id}: ${entry.reason}`).join("; ")})`);
	}
	const responses = outcome.responses as BrainstormResponse[];
	if (responses.reduce((total, item) => total + item.text.length, 0) > MAX_DOCUMENT_CHARS) throw new Error("Round output exceeds the total document size limit");
	return { responses, missing };
}

export function roundFile(id: string): string {
	return `rounds/${id}.md`;
}

function renderRound(state: RunState, round: BrainstormRound): string {
	const { manifest } = state;
	const stored = new Map((manifest.rounds[round] ?? []).map((entry) => [entry.id, entry]));
	const blocks = (state.texts[round] ?? []).map((r) => {
		const warnings = stored.get(r.id)?.warnings;
		const note = warnings?.length ? `> ⚠ Script check: ${warnings.join("; ")}\n\n` : "";
		return `### ${r.id} — ${r.model}\n\n${note}${r.text}`;
	});
	for (const gap of manifest.missing?.[round] ?? []) blocks.push(`### ${gap.id} — ${gap.model}\n\n> Missing (coverage gap): ${gap.reason}`);
	return `## Round ${round}: ${roundName(manifest.mode, round)}\n\n${blocks.join("\n\n---\n\n")}\n`;
}

export function renderDiscussion(state: RunState): string {
	const { manifest } = state;
	const rounds = (Object.keys(state.texts).map(Number).sort() as BrainstormRound[]);
	const matrix = renderPositionMatrix(rounds.filter((round) => round < 5).map((round) => ({ round, responses: (state.texts[round] ?? []).map((r) => ({ slot: participantSlot(r.id), text: r.text })) })));
	const body = rounds.map((round) => renderRound(state, round)).join("\n");
	const reviewLinks = manifest.draftSha256
		? "Round 5 reviews [the preserved draft](draft-proposal.md). Final changes: [revision notes](revision-notes.md), available after finalization.\n"
		: "";
	const failure = manifest.error ? `\n## Execution status: incomplete\n\n${manifest.error}\n` : "";
	return `# Discussion\n\nExecution status: see manifest.json\n\nMode: ${manifest.mode}\n\nModels: ${manifest.models.join(", ")}\n\n${matrix ? `${matrix}\n` : ""}${body}\n${reviewLinks}${failure}`;
}

export function totalChars(state: RunState): number {
	return Object.values(state.texts).flat().reduce((total, response) => total + (response?.text.length ?? 0), 0);
}

export async function collectRound(input: { state: RunState; directory: string; round: BrainstormRound; runRound: RunRound; signal?: AbortSignal; draft?: string }): Promise<void> {
	const { state, round, signal } = input;
	const { manifest } = state;
	checkAbort(signal);
	const tasks = makeTasks({ mode: manifest.mode, topic: manifest.topic, brief: manifest.brief, models: manifest.models, round, rounds: state.texts, draft: input.draft, config: manifest.config, persistent: manifest.execution === "desktop-sessions" });
	const raw = await input.runRound({ round, tasks, signal, runId: manifest.id, runDir: input.directory, topic: manifest.topic, execution: manifest.execution });
	checkAbort(signal);
	const { responses, missing } = validateResponses(raw, tasks, resolvedQuorum(manifest.config));
	if (totalChars(state) + responses.reduce((total, response) => total + response.text.length, 0) > MAX_DOCUMENT_CHARS) throw new Error("Brainstorm output exceeds the total document size limit");
	await mkdir(path.join(input.directory, "rounds"), { recursive: true });
	const stored: StoredResponse[] = [];
	for (const response of responses) {
		const file = roundFile(response.id);
		await replaceDocument(path.join(input.directory, file), response.text);
		const entry: StoredResponse = { id: response.id, model: response.model, file, sha256: sha256(response.text), chars: response.text.length };
		if (response.source) entry.source = response.source;
		const warnings = scriptWarnings(manifest.brief, response.text);
		if (warnings.length) entry.warnings = warnings;
		stored.push(entry);
	}
	state.texts[round] = responses.map(({ id, model, text }) => ({ id, model, text }));
	manifest.rounds[round] = stored;
	if (missing.length) (manifest.missing ??= {})[round] = missing;
}

export async function markIncomplete(runDir: string, state: RunState, error: unknown): Promise<void> {
	state.manifest.status = "incomplete";
	state.manifest.error = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
	await replaceDocument(path.join(runDir, "discussion.md"), renderDiscussion(state)).catch(() => undefined);
	await writeJson(path.join(runDir, "manifest.json"), state.manifest).catch(() => undefined);
}

export async function runBrainstorm(input: { cwd: string; topic: string; brief: string; mode?: BrainstormMode; config: BrainstormConfigInput; signal?: AbortSignal; runRound: RunRound }): Promise<RunBrainstormResult> {
	assertBoundedText(input.topic, "Topic", 2_000);
	assertBoundedText(input.brief, "Brief", 12_000);
	const mode = input.mode === undefined ? "brainstorm" : input.mode;
	assertMode(mode);
	const config = mergeBrainstormConfig(input.config ?? defaultBrainstormConfig(), undefined);
	assertRunnableConfig(config);
	checkAbort(input.signal);
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const { runDir } = await createRunDirectory(input.cwd, input.topic, id, config.outputDir);
	const briefPath = path.join(runDir, "brief.md");
	const discussionPath = path.join(runDir, "discussion.md");
	const proposalPath = path.join(runDir, "proposal.md");
	const manifestPath = path.join(runDir, "manifest.json");
	const manifest: BrainstormManifest = { format: MANIFEST_FORMAT, mode, id, topic: input.topic, brief: input.brief, config, createdAt: new Date().toISOString(), status: "running", models: [...config.models], rounds: {}, ...(input.runRound.execution ? { execution: input.runRound.execution } : {}) };
	const state: RunState = { manifest, texts: {} };
	const thinking = config.models.map((model) => `${model}: ${thinkingForModel(config, model)}`).join(", ");
	try {
		checkAbort(input.signal);
		await writeExclusive(briefPath, `# Council brief\n\n${input.brief}\n\n## Execution\n\n- Mode: ${mode}\n- Topic: ${input.topic}\n- Date: ${manifest.createdAt.slice(0, 10)}\n- Requested models: ${config.models.join(", ")}${config.modelsExplicit ? "" : " (from frontierModels)"}\n- Thinking: ${thinking}\n- Quorum per round: ${resolvedQuorum(config)}/${config.models.length}\n- Timeout per participant per round: ${config.timeoutSeconds}s\n- Rounds: ${([1, 2, 3, 4, 5] as const).map((round) => roundName(mode, round)).join(" → ")}. Parent draft before round 5; parent finalization after review. No implementation.\n`);
		checkAbort(input.signal);
		await writeExclusive(discussionPath, renderDiscussion(state));
		checkAbort(input.signal);
		await writeExclusive(proposalPath, `# ${safeTopicSlug(input.topic)}\n\nStatus: **pending synthesis**\n\nThis file is a placeholder. No synthesis has been performed.\n`);
		checkAbort(input.signal);
		await writeJson(manifestPath, manifest);
		checkAbort(input.signal);
		for (const round of [1, 2, 3, 4] as const) {
			await collectRound({ state, directory: runDir, round, runRound: input.runRound, signal: input.signal });
			await replaceDocument(discussionPath, renderDiscussion(state));
			checkAbort(input.signal);
			await writeJson(manifestPath, manifest);
			checkAbort(input.signal);
		}
		manifest.status = "awaiting_synthesis";
		await writeJson(manifestPath, manifest);
		checkAbort(input.signal);
		return { mode, runDir, status: "awaiting_synthesis", models: [...config.models], discussionPath, proposalPath };
	} catch (error) {
		await markIncomplete(runDir, state, error);
		if (manifest.execution) await input.runRound.onTerminal?.(id, "incomplete");
		return { mode, runDir, status: "incomplete", models: [...config.models], discussionPath, proposalPath };
	}
}
