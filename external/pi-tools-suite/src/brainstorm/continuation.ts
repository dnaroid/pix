import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { BRAINSTORM_PUBLISH_DIR, mergeBrainstormConfig, resolvedQuorum } from "./config.js";
import { assertMode, type BrainstormMode } from "./modes.js";
import { assertBoundedText, ensureConfinedDirectory, LOCK_MODE, MAX_DOCUMENT_CHARS, readJson, replaceDocument, runRoots, validatedRunPath, writeExclusive, writeJson } from "./storage.js";
import {
	checkAbort, collectRound, markIncomplete, MANIFEST_FORMAT, renderDiscussion, roundFile, sha256, validateResponses,
	type BrainstormManifest, type BrainstormResponse, type BrainstormRound, type RunRound, type RunState, type StoredResponse, type TerminalNotification,
} from "./workflow.js";

async function readDocument(directory: string, name: string): Promise<string> {
	const file = path.join(directory, name);
	if (await realpath(file) !== file) throw new Error(`${name} must not be a symlink`);
	return readFile(file, "utf8");
}

type LegacyResponse = { id: string; model: string; text: string };

/**
 * Load and fully validate persisted state. v4 keeps texts in rounds/*.md
 * (verified by SHA-256); v3 and original mode-less v2 store them inline and are
 * migrated to v4 only after validation succeeds.
 */
async function loadState(directory: string, raw: Record<string, unknown>, rounds: readonly BrainstormRound[]): Promise<RunState> {
	const manifest = raw as unknown as BrainstormManifest;
	const format = raw.format as string;
	const legacy = format === "pi-brainstorm-v3" || (format === "pi-brainstorm-v2" && raw.mode === undefined);
	if (format === "pi-brainstorm-v2" && raw.mode === undefined) manifest.mode = "brainstorm";
	if (!legacy && format !== MANIFEST_FORMAT) throw new Error("Only a fully completed v4 (or v3/original v2) run can continue; legacy v1 runs cannot continue");
	if (!/^[a-f0-9]{12}$/.test(manifest.id) || !manifest.config || !Array.isArray(manifest.models) || !manifest.rounds || typeof manifest.rounds !== "object" ||
		Object.keys(manifest.rounds).sort().join(",") !== rounds.join(",")) {
		throw new Error(`Only a fully completed run with rounds ${rounds.join(",")} can continue; incomplete runs cannot continue`);
	}
	assertMode(manifest.mode);
	if (manifest.execution !== undefined && manifest.execution !== "desktop-sessions") throw new Error("Unknown council execution mode; refusing to replace participant sessions");
	if (!/^[a-z0-9-]+$/i.test(path.basename(directory)) || !path.basename(directory).endsWith(`-${manifest.id}`)) throw new Error("Run directory does not match its generated manifest identity");
	assertBoundedText(manifest.topic, "Topic", 2_000);
	assertBoundedText(manifest.brief, "Brief", 12_000);
	manifest.config = mergeBrainstormConfig(manifest.config, undefined);
	if (JSON.stringify(manifest.models) !== JSON.stringify(manifest.config.models)) throw new Error("Stored council roster does not match its configuration snapshot");
	// Legacy runs predate quorum: every participant was required.
	const quorum = legacy ? manifest.models.length : resolvedQuorum(manifest.config);
	const texts: RunState["texts"] = {};
	for (const round of rounds) {
		const expected = manifest.models.map((model, i) => ({ id: `round-${round}-participant-${i + 1}`, model }));
		const stored = manifest.rounds[round] as unknown;
		if (!Array.isArray(stored)) throw new Error(`Round ${round} is malformed`);
		let responses: BrainstormResponse[];
		if (legacy) responses = (stored as LegacyResponse[]).map((item) => ({ id: item?.id, model: item?.model, text: item?.text }));
		else {
			responses = [];
			for (const entry of stored as StoredResponse[]) {
				if (!entry || entry.file !== roundFile(entry.id)) throw new Error(`Round ${round} response file is not the generated path`);
				const text = await readDocument(directory, entry.file);
				if (sha256(text) !== entry.sha256) throw new Error(`${entry.file} changed after it was recorded`);
				responses.push({ id: entry.id, model: entry.model, text });
			}
		}
		const missing = legacy ? [] : manifest.missing?.[round] ?? [];
		validateResponses({ responses, missing }, expected, quorum);
		texts[round] = responses;
	}
	if (Object.values(texts).flat().reduce((sum, response) => sum + (response?.text.length ?? 0), 0) > MAX_DOCUMENT_CHARS) throw new Error("Stored council output exceeds the total document size limit");
	if (legacy) {
		for (const round of rounds) {
			manifest.rounds[round] = (texts[round] ?? []).map(({ id, model, text }) => ({ id, model, file: roundFile(id), sha256: sha256(text), chars: text.length }));
		}
		manifest.format = MANIFEST_FORMAT;
	}
	return { manifest, texts };
}

async function persistMigratedTexts(directory: string, state: RunState): Promise<void> {
	await ensureConfinedDirectory(directory, "rounds");
	for (const responses of Object.values(state.texts)) {
		for (const response of responses ?? []) {
			const file = path.join(directory, roundFile(response.id));
			const existing = await readFile(file, "utf8").catch(() => undefined);
			if (existing !== response.text) await replaceDocument(file, response.text);
		}
	}
}

/** One lock covers both continuation actions; state must be read after acquisition. */
async function withRunLock<T>(cwd: string, runDir: string, outputDir: string | undefined, status: "awaiting_synthesis" | "awaiting_finalization", signal: AbortSignal | undefined, operation: (directory: string, state: RunState) => Promise<T>): Promise<T> {
	checkAbort(signal);
	const roots = runRoots(outputDir);
	const { directory, manifestPath } = await validatedRunPath(cwd, runDir, roots);
	const lockPath = path.join(directory, ".finalize.lock");
	try {
		await writeExclusive(lockPath, "Brainstorm continuation in progress\n", LOCK_MODE);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Brainstorm continuation is already in progress; inspect the existing lock if the host crashed");
		throw error;
	}
	try {
		await validatedRunPath(cwd, runDir, roots);
		const raw = await readJson<Record<string, unknown>>(manifestPath);
		if (raw.status !== status) throw new Error(`Only a fully completed run with status ${status} can continue; incomplete and legacy v1 runs cannot continue`);
		const rounds = status === "awaiting_synthesis" ? [1, 2, 3, 4] as const : [1, 2, 3, 4, 5] as const;
		const state = await loadState(directory, raw, rounds);
		if (!(await readDocument(directory, "proposal.md")).includes("Status: **pending synthesis**")) throw new Error("Proposal has already been finalized");
		checkAbort(signal);
		await persistMigratedTexts(directory, state);
		return await operation(directory, state);
	} finally {
		await rm(lockPath, { force: true });
	}
}

export async function reviewBrainstorm(input: { cwd: string; runDir: string; proposal: string; signal?: AbortSignal; runRound: RunRound; outputDir?: string }): Promise<{ mode: BrainstormMode; status: "awaiting_finalization" | "incomplete"; runDir: string; draftPath: string; discussionPath: string }> {
	assertBoundedText(input.proposal, "Draft proposal", 40_000);
	return withRunLock(input.cwd, input.runDir, input.outputDir, "awaiting_synthesis", input.signal, async (directory, state) => {
		const { manifest } = state;
		input.runRound.validateExecution?.(manifest.execution);
		const draftPath = path.join(directory, "draft-proposal.md");
		const discussionPath = path.join(directory, "discussion.md");
		try {
			await writeExclusive(draftPath, input.proposal);
			manifest.draftSha256 = sha256(input.proposal);
			manifest.status = "reviewing_synthesis";
			await writeJson(path.join(directory, "manifest.json"), manifest);
			await collectRound({ state, directory, round: 5, runRound: input.runRound, signal: input.signal, draft: input.proposal });
			await replaceDocument(discussionPath, renderDiscussion(state));
			checkAbort(input.signal);
			manifest.status = "awaiting_finalization";
			await writeJson(path.join(directory, "manifest.json"), manifest);
			checkAbort(input.signal);
			return { mode: manifest.mode, status: "awaiting_finalization", runDir: directory, draftPath, discussionPath };
		} catch (error) {
			await markIncomplete(directory, state, error);
			if (manifest.execution) await input.runRound.onTerminal?.(manifest.id, "incomplete");
			return { mode: manifest.mode, status: "incomplete", runDir: directory, draftPath, discussionPath };
		}
	});
}

export interface FinalizeOptions { outputDir?: string; publish?: boolean; signal?: AbortSignal; onTerminal?: TerminalNotification }

/** Finalize; with `publish`, also copy the proposal (only) into docs/brainstorms/. */
export async function finalizeBrainstormRun(cwd: string, runDir: string, proposal: string, revisionNotes: string, options: FinalizeOptions = {}): Promise<{ proposalPath: string; publishedPath?: string }> {
	const { signal } = options;
	assertBoundedText(proposal, "Proposal", MAX_DOCUMENT_CHARS);
	assertBoundedText(revisionNotes, "Revision notes", 40_000);
	return withRunLock(cwd, runDir, options.outputDir, "awaiting_finalization", signal, async (directory, state) => {
		const { manifest } = state;
		const draft = await readDocument(directory, "draft-proposal.md");
		if (sha256(draft) !== manifest.draftSha256) throw new Error("Draft synthesis changed after review; finalization refused");
		checkAbort(signal);
		const proposalPath = path.join(directory, "proposal.md");
		let publishedPath: string | undefined;
		try {
			await writeExclusive(path.join(directory, "revision-notes.md"), revisionNotes);
			checkAbort(signal);
			await replaceDocument(proposalPath, proposal);
			checkAbort(signal);
			if (options.publish) {
				const publishRoot = await ensureConfinedDirectory(cwd, BRAINSTORM_PUBLISH_DIR);
				if (path.dirname(directory) !== publishRoot) {
					const target = path.join(publishRoot, `${path.basename(directory)}.md`);
					publishedPath = target;
					const protocol = path.relative(await realpath(cwd), directory);
					await writeExclusive(target, `${proposal.replace(/\s*$/, "")}\n\n---\n\nCouncil protocol (local, not published): \`${protocol}/\`\n`);
				} else publishedPath = proposalPath;
				manifest.publishedPath = publishedPath;
			}
			manifest.status = "complete";
			await writeJson(path.join(directory, "manifest.json"), manifest);
			checkAbort(signal);
		} catch (error) {
			await markIncomplete(directory, state, error);
			if (manifest.execution) await options.onTerminal?.(manifest.id, "incomplete");
			throw error;
		}
		if (manifest.execution) await options.onTerminal?.(manifest.id, "complete");
		return publishedPath ? { proposalPath, publishedPath } : { proposalPath };
	});
}

export async function finalizeBrainstorm(cwd: string, runDir: string, proposal: string, revisionNotes: string, signal?: AbortSignal, options: Omit<FinalizeOptions, "signal"> = {}): Promise<string> {
	return (await finalizeBrainstormRun(cwd, runDir, proposal, revisionNotes, { ...options, signal })).proposalPath;
}
