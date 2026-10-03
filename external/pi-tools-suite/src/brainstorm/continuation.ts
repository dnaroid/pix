import { createHash } from "node:crypto";
import { readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { defaultBrainstormConfig, mergeBrainstormConfig } from "./config.js";
import { assertMode, type BrainstormMode } from "./modes.js";
import { assertBoundedText, MAX_DOCUMENT_CHARS, readManifest, replaceDocument, validatedRunPath, writeExclusive, writeManifest } from "./storage.js";
import { checkAbort, collectRound, markIncomplete, renderDiscussion, validateResponses, type BrainstormManifest, type BrainstormRound, type RunRound } from "./workflow.js";

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

async function readDocument(directory: string, name: string): Promise<string> {
	const file = path.join(directory, name);
	if (await realpath(file) !== file) throw new Error(`${name} must not be a symlink`);
	return readFile(file, "utf8");
}

/** One lock covers both continuation actions; state must be read after acquisition. */
async function withRunLock<T>(cwd: string, runDir: string, status: "awaiting_synthesis" | "awaiting_finalization", signal: AbortSignal | undefined, operation: (directory: string, manifest: BrainstormManifest) => Promise<T>): Promise<T> {
	checkAbort(signal);
	const { directory, manifestPath } = await validatedRunPath(cwd, runDir);
	const lockPath = path.join(directory, ".finalize.lock");
	try {
		await writeExclusive(lockPath, "Brainstorm continuation in progress\n");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Brainstorm continuation is already in progress; inspect the existing lock if the host crashed");
		throw error;
	}
	try {
		await validatedRunPath(cwd, runDir);
		const manifest = await readManifest(manifestPath);
		// v2 predates modes and can only mean the original brainstorming protocol.
		if ((manifest.format as string) === "pi-brainstorm-v2" && manifest.mode === undefined) {
			manifest.format = "pi-brainstorm-v3";
			manifest.mode = "brainstorm";
		}
		const rounds = status === "awaiting_synthesis" ? [1, 2, 3, 4] as const : [1, 2, 3, 4, 5] as const;
		if (manifest.format !== "pi-brainstorm-v3" || manifest.status !== status || !/^[a-f0-9]{12}$/.test(manifest.id) || !manifest.config || !Array.isArray(manifest.models) || !manifest.rounds || Object.keys(manifest.rounds).sort().join(",") !== rounds.join(",")) {
			throw new Error(`Only a fully completed v3 (or original v2) run with status ${status} can continue; incomplete and legacy v1 runs cannot continue`);
		}
		assertMode(manifest.mode);
		if (!/^[a-z0-9-]+$/i.test(path.basename(directory)) || !path.basename(directory).endsWith(`-${manifest.id}`)) throw new Error("Run directory does not match its generated manifest identity");
		assertBoundedText(manifest.topic, "Topic", 2_000);
		assertBoundedText(manifest.brief, "Brief", 12_000);
		manifest.config = mergeBrainstormConfig(defaultBrainstormConfig(), manifest.config);
		if (JSON.stringify(manifest.models) !== JSON.stringify(manifest.config.models)) throw new Error("Stored council roster does not match its configuration snapshot");
		for (const round of rounds) {
			validateResponses(manifest.rounds[round as BrainstormRound], manifest.models.map((model, i) => ({ id: `round-${round}-participant-${i + 1}`, model, task: "", thinking: manifest.config.thinking, timeoutSeconds: manifest.config.timeoutSeconds })));
		}
		if (Object.values(manifest.rounds).flat().reduce((sum, response) => sum + response.text.length, 0) > MAX_DOCUMENT_CHARS) throw new Error("Stored council output exceeds the total document size limit");
		if (!(await readDocument(directory, "proposal.md")).includes("Status: **pending synthesis**")) throw new Error("Proposal has already been finalized");
		checkAbort(signal);
		return await operation(directory, manifest);
	} finally {
		await rm(lockPath, { force: true });
	}
}

export async function reviewBrainstorm(input: { cwd: string; runDir: string; proposal: string; signal?: AbortSignal; runRound: RunRound }): Promise<{ mode: BrainstormMode; status: "awaiting_finalization" | "incomplete"; runDir: string; draftPath: string; discussionPath: string }> {
	assertBoundedText(input.proposal, "Draft proposal", 40_000);
	return withRunLock(input.cwd, input.runDir, "awaiting_synthesis", input.signal, async (directory, manifest) => {
		const draftPath = path.join(directory, "draft-proposal.md");
		const discussionPath = path.join(directory, "discussion.md");
		try {
			await writeExclusive(draftPath, input.proposal);
			manifest.draftSha256 = digest(input.proposal);
			manifest.status = "reviewing_synthesis";
			await writeManifest(path.join(directory, "manifest.json"), manifest);
			await collectRound({ manifest, round: 5, runRound: input.runRound, signal: input.signal, draft: input.proposal });
			await replaceDocument(discussionPath, renderDiscussion(manifest));
			checkAbort(input.signal);
			manifest.status = "awaiting_finalization";
			await writeManifest(path.join(directory, "manifest.json"), manifest);
			checkAbort(input.signal);
			return { mode: manifest.mode, status: "awaiting_finalization", runDir: directory, draftPath, discussionPath };
		} catch (error) {
			await markIncomplete(directory, manifest, error);
			return { mode: manifest.mode, status: "incomplete", runDir: directory, draftPath, discussionPath };
		}
	});
}

export async function finalizeBrainstorm(cwd: string, runDir: string, proposal: string, revisionNotes: string, signal?: AbortSignal): Promise<string> {
	assertBoundedText(proposal, "Proposal", MAX_DOCUMENT_CHARS);
	assertBoundedText(revisionNotes, "Revision notes", 40_000);
	return withRunLock(cwd, runDir, "awaiting_finalization", signal, async (directory, manifest) => {
		const draft = await readDocument(directory, "draft-proposal.md");
		if (digest(draft) !== manifest.draftSha256) throw new Error("Draft synthesis changed after review; finalization refused");
		checkAbort(signal);
		const proposalPath = path.join(directory, "proposal.md");
		try {
			await writeExclusive(path.join(directory, "revision-notes.md"), revisionNotes);
			checkAbort(signal);
			await replaceDocument(proposalPath, proposal);
			checkAbort(signal);
			manifest.status = "complete";
			await writeManifest(path.join(directory, "manifest.json"), manifest);
			checkAbort(signal);
		} catch (error) {
			await markIncomplete(directory, manifest, error);
			throw error;
		}
		return proposalPath;
	});
}
