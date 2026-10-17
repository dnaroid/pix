// Deterministic council protocol: manifest, hashes, quorum, round files.
// The parent agent drives subagents; this module only validates what they
// produced and prepares the next round. It never launches models.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyRunModels, assertRunnable, loadCouncilConfig, resolvedQuorum, thinkingForModel } from "./config.mjs";
import { renderPositionMatrix, scriptWarnings } from "./ledger.mjs";
import { boundaries, loadTemplates, render, roundName, roundPrompt } from "./prompts.mjs";
import {
	assertBoundedText, CouncilError, createRunDirectory, ensureConfinedDirectory, ensureRunSubdirectory, MAX_DOCUMENT_CHARS, PUBLISH_DIR,
	readDocument, replaceDocument, runRoots, safeTopicSlug, validatedRunPath, withRunLock, writeExclusive, writeJson,
} from "./storage.mjs";
import { assertBatchName, findChildSession, readChildSession, readParentRecord } from "./subagent-state.mjs";

export const MANIFEST_FORMAT = "pi-brainstorm-v6";
export const MAX_RESPONSE_CHARS = 40_000;
const MAX_RESULT_BYTES = 64 * 1024;
const PENDING_MARKER = "Status: **pending synthesis**";
/** Read-only participant tool allowlist; council-guard.ts keeps the same list. */
export const COUNCIL_TOOLS = ["read", "grep", "web_search", "web_fetch", "project_search"];
export const GUARD_PATH = fileURLToPath(new URL("../../council-guard.ts", import.meta.url));
const FORCE_MODEL_ENV = ["ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL", "PI_SUBAGENTS_FORCE_CURRENT_MODEL", "ASYNC_SUBAGENTS_USE_CURRENT_MODEL", "PI_SUBAGENTS_USE_CURRENT_MODEL"];

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

export function expectedExtraArgs() {
	return ["--extension", GUARD_PATH, "--tools", COUNCIL_TOOLS.join(",")];
}

const agentId = (slot) => `p${slot}`;
const responseId = (round, slot) => `round-${round}-participant-${slot}`;
const responseFile = (round, slot) => `rounds/${responseId(round, slot)}.md`;
const promptFile = (round, slot) => `prompts/round-${round}-p${slot}.md`;

function assertMode(mode) {
	if (mode !== "brainstorm" && mode !== "audit") throw new CouncilError("--mode must be brainstorm or audit; resolve auto routing before paid work.");
}

function safeRoots(options) {
	try { return runRoots(loadCouncilConfig(options).outputDir); }
	catch { return runRoots(undefined); }
}

function briefDocument(manifest, templates) {
	const { config, mode } = manifest;
	const thinking = manifest.participants.map((p) => `${p.model}: ${p.thinking}`).join(", ");
	const rounds = [1, 2, 3, 4, 5].map((round) => roundName(templates, mode, round)).join(" → ");
	return `# Council brief\n\n${manifest.brief}\n\n## Execution\n\n- Mode: ${mode}\n- Topic: ${manifest.topic}\n- Date: ${manifest.createdAt.slice(0, 10)}\n- Models: ${config.models.join(", ")}${config.modelsExplicit ? "" : " (from frontierModels)"}\n- Thinking: ${thinking}\n- Quorum per round: ${resolvedQuorum(config)}/${config.models.length}\n- Timeout per participant per round: ${config.timeoutSeconds}s\n- Participant batch: ${manifest.subagentRunDir}\n- Rounds: ${rounds}. Parent draft before round 5; parent finalization after review. No implementation.\n`;
}

export function renderDiscussion(manifest, texts, templates) {
	const rounds = Object.keys(manifest.rounds).map(Number).sort((a, b) => a - b);
	const matrix = renderPositionMatrix(rounds.filter((round) => round < 5).map((round) => ({
		round, responses: manifest.rounds[round].map((entry) => ({ slot: entry.slot, text: texts[round]?.[entry.slot] ?? "" })),
	})));
	const body = rounds.map((round) => {
		const blocks = manifest.rounds[round].map((entry) => {
			const note = entry.warnings?.length ? `> ⚠ Script check: ${entry.warnings.join("; ")}\n\n` : "";
			return `### ${entry.id} — ${entry.model}\n\n${note}${texts[round]?.[entry.slot] ?? ""}`;
		});
		for (const gap of manifest.missing[round] ?? []) blocks.push(`### ${gap.id} — ${gap.model}\n\n> Missing (coverage gap): ${gap.reason}`);
		return `## Round ${round}: ${roundName(templates, manifest.mode, round)}\n\n${blocks.join("\n\n---\n\n")}\n`;
	}).join("\n");
	const review = manifest.draftSha256 ? "Round 5 reviews [the preserved draft](draft-proposal.md). Final changes: [revision notes](revision-notes.md), available after finalization.\n" : "";
	const failure = manifest.error ? `\n## Execution status: incomplete\n\n${manifest.error}\n` : "";
	return `# Discussion\n\nExecution status: see manifest.json\n\nMode: ${manifest.mode}\n\nModels: ${manifest.config.models.join(", ")}\n\n${matrix ? `${matrix}\n` : ""}${body}\n${review}${failure}`;
}

function validateManifest(directory, manifest) {
	if (manifest?.format !== MANIFEST_FORMAT) throw new CouncilError(`Only ${MANIFEST_FORMAT} council runs can continue; start a new run.`);
	if (!/^[a-f0-9]{12}$/.test(manifest.id) || !path.basename(directory).endsWith(`-${manifest.id}`)) throw new CouncilError("Run directory does not match its manifest identity");
	assertMode(manifest.mode);
	const participants = manifest.participants;
	if (!Array.isArray(participants) || participants.length < 2 || participants.length > 6 ||
		participants.some((p, index) => p?.slot !== index + 1 || p.model !== manifest.config?.models?.[index])) {
		throw new CouncilError("Stored participants do not match the configuration snapshot");
	}
	if (!manifest.rounds || typeof manifest.rounds !== "object" || !manifest.missing || typeof manifest.missing !== "object") throw new CouncilError("Manifest rounds are malformed");
	if (!Array.isArray(manifest.expectedExtraArgs)) throw new CouncilError("Manifest lacks the participant launch contract");
	assertBatchName(manifest.subagentRunDir);
}

async function loadRun(options) {
	const { directory, manifestPath, cwd } = await validatedRunPath(options.cwd, options.run, safeRoots(options));
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	validateManifest(directory, manifest);
	const texts = {};
	const integrity = [];
	for (const [key, entries] of Object.entries(manifest.rounds)) {
		const round = Number(key);
		if (!Array.isArray(entries)) throw new CouncilError(`Round ${round} is malformed`);
		texts[round] = {};
		for (const entry of entries) {
			if (entry?.file !== responseFile(round, entry.slot)) throw new CouncilError(`Round ${round} response file is not the generated path`);
				const text = await readDocument(directory, entry.file).catch((error) => { integrity.push(`${entry.file}: ${error.message}`); return undefined; });
			if (text === undefined) continue;
			if (sha256(text) !== entry.sha256) { integrity.push(`${entry.file} changed after it was recorded`); continue; }
			texts[round][entry.slot] = text;
		}
	}
	return { directory, manifestPath, cwd, manifest, texts, ...(integrity.length ? { integrityError: `Protocol integrity failure: ${integrity.join("; ")}` } : {}) };
}

/** Mutating commands refuse tampered runs and persist the incomplete state. */
async function assertIntact(state, templates) {
	if (!state.integrityError) return;
	if (state.manifest.status !== "incomplete" && state.manifest.status !== "complete") await markIncomplete(state, templates, new Error(state.integrityError));
	throw new CouncilError(state.integrityError, 1);
}

async function markIncomplete(state, templates, error) {
	state.manifest.status = "incomplete";
	state.manifest.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
	await replaceDocument(path.join(state.directory, "discussion.md"), renderDiscussion(state.manifest, state.texts, templates)).catch(() => undefined);
	await writeJson(state.manifestPath, state.manifest).catch(() => undefined);
}

/** Run a mutation; failures after validation mark the run incomplete. */
async function mutate(state, templates, operation) {
	try { return await operation(); }
	catch (error) {
		await markIncomplete(state, templates, error);
		throw error instanceof CouncilError ? Object.assign(error, { code: 1 }) : new CouncilError(error instanceof Error ? error.message : String(error), 1);
	}
}

/** Classify one participant's answer for a round from its child and parent sessions. */
export async function inspectParticipant(cwd, batch, participant, round, expectedArgs) {
	const label = agentId(participant.slot);
	const child = await findChildSession(cwd, batch, label);
	if (!child) {
		if (round === 1) return { kind: "pending", undelivered: true, reason: "not launched (spawn it)" };
		throw new CouncilError(`${label} has no persisted session; it cannot be a continuation`, 1);
	}
	const parent = await readParentRecord(child.meta.parentSession, child.meta);
	if (!parent) throw new CouncilError(`${label} has no sub-agent record in a persisted parent session; councils require a saved parent session`, 1);
	const { record } = parent;
	const task = record.task ?? {};
	if (task.model !== participant.model) throw new CouncilError(`${label} ran ${task.model ?? "an unknown model"} instead of ${participant.model}; model substitution is not allowed (disable forced-current-model overrides)`, 1);
	if (task.subagentType !== "research") throw new CouncilError(`${label} must use the research role`, 1);
	if (JSON.stringify(record.extraArgs ?? []) !== JSON.stringify(expectedArgs)) throw new CouncilError(`${label} launch arguments differ from the read-only council contract; research.extraArgs and global extraArgs must be empty`, 1);
	if (task.thinking !== participant.thinking) throw new CouncilError(`${label} ran thinking ${task.thinking ?? "default"} instead of ${participant.thinking}`, 1);
	const turns = (Number.isInteger(record.turn) ? record.turn : 1) - 1;
	if (turns > round - 1) throw new CouncilError(`${label} has ${turns + 1} turns, more than round ${round}; extra messages were sent to a council participant`, 1);
	if (turns < round - 1) return { kind: "pending", undelivered: true, reason: `round ${round} message not delivered (send it)` };
	if (!["done", "failed", "stopped"].includes(record.status)) return { kind: "pending", reason: record.status ?? "running" };
	const session = await readChildSession(child.file);
	if (session.userMessages > round) throw new CouncilError(`${label} session has ${session.userMessages} user messages, more than round ${round}; extra messages were sent to a council participant`, 1);
	if (session.userMessages < round && record.status === "done") return { kind: "pending", reason: `round ${round} message not yet in the session` };
	const reported = record.structured?.model;
	if (reported && reported !== participant.model) throw new CouncilError(`${label} reported model ${reported} instead of ${participant.model}`, 1);
	if (record.status !== "done") return { kind: "gap", reason: `participant ${record.status}` };
	const text = session.lastText ?? record.message ?? "";
	// A send/respawn appends parent entries: accept only an unchanged snapshot.
	if ((await readParentRecord(child.meta.parentSession, child.meta))?.entries !== parent.entries) {
		return { kind: "pending", reason: "session state changed while reading; collect again" };
	}
	if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES || text.length > MAX_RESPONSE_CHARS) return { kind: "gap", reason: `response exceeds ${MAX_RESPONSE_CHARS} characters` };
	if (!text.trim()) return { kind: "gap", reason: "empty response" };
	return { kind: "done", text, turn: turns + 1 };
}

async function writePrompts(state, templates, round, draft) {
	const { manifest, directory, texts } = state;
	await ensureRunSubdirectory(directory, "prompts");
	const prior = round - 1;
	for (const participant of manifest.participants.filter((p) => p.active)) {
		const peers = round === 1 ? [] : (manifest.rounds[prior] ?? [])
			.filter((entry) => entry.slot !== participant.slot)
			.map((entry) => ({ id: entry.id, model: entry.model, text: texts[prior][entry.slot] }));
		const gaps = round === 1 ? [] : (manifest.missing[prior] ?? []).map(({ id, model, reason }) => ({ id, model, reason }));
		const text = roundPrompt(templates, {
			mode: manifest.mode, round, slot: participant.slot, model: participant.model,
			topic: manifest.topic, brief: manifest.brief, peers, gaps, ...(draft === undefined ? {} : { draft }),
		});
		await replaceDocument(path.join(directory, promptFile(round, participant.slot)), text);
	}
}

function waitAction(manifest) {
	const active = manifest.participants.filter((p) => p.active);
	return { action: "wait", runDir: manifest.subagentRunDir, agentIds: active.map((p) => agentId(p.slot)), timeout: Math.min(manifest.config.timeoutSeconds + 60, 1800) };
}

function spawnTask(manifest, templates, directory, p) {
	return {
		id: agentId(p.slot), model: p.model, thinking: p.thinking, timeoutSeconds: manifest.config.timeoutSeconds,
		subagentType: "research", tools: ["read"], extraArgs: manifest.expectedExtraArgs, promptOverride: "{task}",
		task: render(templates["spawn-task"].body, { boundaries: boundaries(templates, p.slot, p.model), file: path.join(directory, promptFile(1, p.slot)), round: 1 }),
	};
}

/** Retry actions for participants whose spawn/send never took effect (safe to repeat). */
function deliveryActions(state, templates, undelivered) {
	const { manifest, directory } = state;
	if (!undelivered.length) return {};
	if (manifest.round === 1) {
		return { respawn: { action: "spawn", runDir: manifest.subagentRunDir, watchSeconds: 0, tasks: undelivered.map((p) => spawnTask(manifest, templates, directory, p)) } };
	}
	const slots = new Set(undelivered.map((p) => p.slot));
	return { resend: sendActions(state, templates, manifest.round).filter((send) => slots.has(Number(send.agentId.slice(1)))) };
}

async function undeliveredParticipants(state) {
	const { manifest } = state;
	if (!["running", "reviewing_synthesis"].includes(manifest.status)) return [];
	const batch = assertBatchName(manifest.subagentRunDir);
	const result = [];
	for (const p of manifest.participants.filter((item) => item.active)) {
		const child = await findChildSession(state.cwd, batch, agentId(p.slot));
		if (manifest.round === 1) {
			if (!child) result.push(p);
			continue;
		}
		if (!child) continue;
		const turn = (await readParentRecord(child.meta.parentSession, child.meta))?.record.turn;
		if (Number.isInteger(turn) && turn - 1 < manifest.round - 1) result.push(p);
	}
	return result;
}

function sendActions(state, templates, round) {
	const { manifest, directory } = state;
	return manifest.participants.filter((p) => p.active).map((p) => ({
		action: "send", runDir: manifest.subagentRunDir, agentId: agentId(p.slot),
		message: render(templates["send-message"].body, { round, file: path.join(directory, promptFile(round, p.slot)) }),
	}));
}

export async function initCouncil(options) {
	const { cwd, mode, topic, brief, env = process.env } = options;
	assertMode(mode);
	assertBoundedText(topic, "Topic", 2_000);
	assertBoundedText(brief, "Brief", 12_000);
	const forced = FORCE_MODEL_ENV.find((name) => /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? ""));
	if (forced) throw new CouncilError(`Disable ${forced} for the council: participants require their exact models.`);
	const templates = await loadTemplates(options.templatesPath);
	let config = loadCouncilConfig({ cwd, env, homeDir: options.homeDir });
	if (options.models !== undefined) config = applyRunModels(config, options.models);
	assertRunnable(config);
	const { sources, ...snapshot } = config;
	const id = randomBytes(6).toString("hex");
	const directory = await createRunDirectory(cwd, topic, id, config.outputDir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const manifest = {
		format: MANIFEST_FORMAT, id, mode, topic, brief, createdAt: new Date().toISOString(),
		status: "running", round: 1, config: snapshot, configSources: sources,
		subagentRunDir: `${stamp}-brainstorm-${id}`,
		expectedExtraArgs: expectedExtraArgs(),
		participants: config.models.map((model, index) => ({ slot: index + 1, model, thinking: thinkingForModel(config, model), active: true })),
		rounds: {}, missing: {},
	};
	const state = { directory, manifestPath: path.join(directory, "manifest.json"), manifest, texts: {} };
	await writeExclusive(path.join(directory, "brief.md"), briefDocument(manifest, templates));
	await writeExclusive(path.join(directory, "discussion.md"), renderDiscussion(manifest, {}, templates));
	await writeExclusive(path.join(directory, "proposal.md"), `# ${safeTopicSlug(topic)}\n\n${PENDING_MARKER}\n\nThis file is a placeholder. No synthesis has been performed.\n`);
	await writePrompts(state, templates, 1);
	await writeJson(state.manifestPath, manifest);
	return {
		status: "running", round: 1, runDir: directory, mode, models: config.models, quorum: resolvedQuorum(config),
		spawn: {
			action: "spawn", runDir: manifest.subagentRunDir, watchSeconds: 0,
			tasks: manifest.participants.map((p) => spawnTask(manifest, templates, directory, p)),
		},
		wait: waitAction(manifest),
	};
}

/** Parse --missing "p2=reason,p3=reason" into a map keyed by agent id. */
export function parseMissing(value) {
	const map = new Map();
	if (value === undefined) return map;
	for (const part of String(value).split(",").map((item) => item.trim()).filter(Boolean)) {
		const [id, ...reason] = part.split("=");
		if (!/^p[1-6]$/.test(id)) throw new CouncilError(`--missing entries must look like p2=reason, got "${part}"`);
		map.set(id, reason.join("=").trim() || "declared missing by the parent");
	}
	return map;
}

export async function collectRound(options) {
	const templates = await loadTemplates(options.templatesPath);
	const located = await validatedRunPath(options.cwd, options.run, safeRoots(options));
	return withRunLock(located.directory, async () => {
		const state = await loadRun(options);
		await assertIntact(state, templates);
		const { manifest } = state;
		if (manifest.status !== "running" && manifest.status !== "reviewing_synthesis") throw new CouncilError(`Nothing to collect: run status is ${manifest.status}`);
		const round = manifest.round;
		const declared = options.missing instanceof Map ? options.missing : parseMissing(options.missing);
		const active = manifest.participants.filter((p) => p.active);
		for (const id of declared.keys()) if (!active.some((p) => agentId(p.slot) === id)) throw new CouncilError(`--missing ${id} is not an active participant`);
		const batch = assertBatchName(manifest.subagentRunDir);
		return mutate(state, templates, async () => {
			const outcomes = [];
			for (const participant of active) outcomes.push({ participant, ...(await inspectParticipant(state.cwd, batch, participant, round, manifest.expectedExtraArgs)) });
			const pending = outcomes.filter((o) => o.kind === "pending" && !declared.has(agentId(o.participant.slot)));
			if (pending.length) {
				const undelivered = pending.filter((o) => o.undelivered).map((o) => o.participant);
				return { status: "pending", round, runDir: state.directory, pending: pending.map((o) => ({ agentId: agentId(o.participant.slot), reason: o.reason })), ...deliveryActions(state, templates, undelivered), wait: waitAction(manifest) };
			}
			const done = outcomes.filter((o) => o.kind === "done");
			const gaps = outcomes.filter((o) => o.kind !== "done").map((o) => ({
				slot: o.participant.slot, id: responseId(round, o.participant.slot), model: o.participant.model,
				reason: (o.kind === "pending" ? declared.get(agentId(o.participant.slot)) : o.reason).slice(0, 500),
			}));
			const quorum = resolvedQuorum(manifest.config);
			if (done.length < quorum) throw new CouncilError(`Round ${round} quorum not met: ${done.length}/${manifest.participants.length} answers, ${quorum} required (${gaps.map((g) => `${g.id}: ${g.reason}`).join("; ")})`, 1);
			const total = Object.values(state.texts).flatMap((byslot) => Object.values(byslot)).reduce((sum, text) => sum + text.length, 0) + done.reduce((sum, o) => sum + o.text.length, 0);
			if (total > MAX_DOCUMENT_CHARS) throw new CouncilError("Council output exceeds the total document size limit", 1);
			await ensureRunSubdirectory(state.directory, "rounds");
			state.texts[round] = {};
			manifest.rounds[round] = [];
			for (const o of done) {
				const { slot, model } = o.participant;
				await replaceDocument(path.join(state.directory, responseFile(round, slot)), o.text);
				const entry = { slot, id: responseId(round, slot), model, file: responseFile(round, slot), sha256: sha256(o.text), chars: o.text.length, agent: agentId(slot), turn: o.turn };
				const warnings = scriptWarnings(manifest.brief, o.text);
				if (warnings.length) entry.warnings = warnings;
				manifest.rounds[round].push(entry);
				state.texts[round][slot] = o.text;
			}
			if (gaps.length) manifest.missing[round] = gaps;
			for (const gap of gaps) Object.assign(manifest.participants[gap.slot - 1], { active: false, droppedRound: round, dropReason: gap.reason });
			let result;
			if (round < 4) {
				manifest.round = round + 1;
				await writePrompts(state, templates, round + 1);
				result = { status: "running", round: round + 1, runDir: state.directory, sends: sendActions(state, templates, round + 1), wait: waitAction(manifest) };
			} else if (round === 4) {
				manifest.status = "awaiting_synthesis";
				result = { status: "awaiting_synthesis", runDir: state.directory, next: "Read brief.md and discussion.md, write the draft, then run review --draft-file <file>." };
			} else {
				manifest.status = "awaiting_finalization";
				result = { status: "awaiting_finalization", runDir: state.directory, next: "Read draft-proposal.md and the round 5 reviews in discussion.md, then run finalize." };
			}
			await replaceDocument(path.join(state.directory, "discussion.md"), renderDiscussion(manifest, state.texts, templates));
			await writeJson(state.manifestPath, manifest);
			return { ...result, gaps: gaps.map(({ id, reason }) => ({ id, reason })) };
		});
	});
}

function requireRounds(manifest, rounds) {
	if (Object.keys(manifest.rounds).map(Number).sort((a, b) => a - b).join(",") !== rounds.join(",")) {
		throw new CouncilError(`Run must have completed rounds ${rounds.join(",")}`);
	}
}

export async function reviewCouncil(options) {
	assertBoundedText(options.draft, "Draft proposal", MAX_RESPONSE_CHARS);
	const templates = await loadTemplates(options.templatesPath);
	const located = await validatedRunPath(options.cwd, options.run, safeRoots(options));
	return withRunLock(located.directory, async () => {
		const state = await loadRun(options);
		await assertIntact(state, templates);
		const { manifest } = state;
		if (manifest.status !== "awaiting_synthesis") throw new CouncilError(`Review requires status awaiting_synthesis, not ${manifest.status}`);
		requireRounds(manifest, [1, 2, 3, 4]);
		return mutate(state, templates, async () => {
			await writeExclusive(path.join(state.directory, "draft-proposal.md"), options.draft);
			manifest.draftSha256 = sha256(options.draft);
			manifest.status = "reviewing_synthesis";
			manifest.round = 5;
			await writePrompts(state, templates, 5, options.draft);
			await replaceDocument(path.join(state.directory, "discussion.md"), renderDiscussion(manifest, state.texts, templates));
			await writeJson(state.manifestPath, manifest);
			return { status: "reviewing_synthesis", round: 5, runDir: state.directory, sends: sendActions(state, templates, 5), wait: waitAction(manifest) };
		});
	});
}

export async function finalizeCouncil(options) {
	assertBoundedText(options.proposal, "Proposal", MAX_DOCUMENT_CHARS);
	assertBoundedText(options.notes, "Revision notes", MAX_RESPONSE_CHARS);
	const templates = await loadTemplates(options.templatesPath);
	const located = await validatedRunPath(options.cwd, options.run, safeRoots(options));
	return withRunLock(located.directory, async () => {
		const state = await loadRun(options);
		await assertIntact(state, templates);
		const { manifest, directory } = state;
		if (manifest.status !== "awaiting_finalization") throw new CouncilError(`Finalize requires status awaiting_finalization, not ${manifest.status}`);
		requireRounds(manifest, [1, 2, 3, 4, 5]);
		if (sha256(await readDocument(directory, "draft-proposal.md")) !== manifest.draftSha256) throw new CouncilError("Draft synthesis changed after review; finalization refused");
		if (!(await readDocument(directory, "proposal.md")).includes(PENDING_MARKER)) throw new CouncilError("Proposal has already been finalized");
		return mutate(state, templates, async () => {
			await writeExclusive(path.join(directory, "revision-notes.md"), options.notes);
			const proposalPath = path.join(directory, "proposal.md");
			await replaceDocument(proposalPath, options.proposal);
			let publishedPath;
			if (options.publish) {
				const root = await ensureConfinedDirectory(state.cwd, PUBLISH_DIR);
				publishedPath = path.join(root, `${path.basename(directory)}.md`);
				await writeExclusive(publishedPath, `${options.proposal.replace(/\s*$/, "")}\n\n---\n\nCouncil protocol (local, not published): \`${path.relative(state.cwd, directory)}/\`\n`);
				manifest.publishedPath = publishedPath;
			}
			manifest.status = "complete";
			await writeJson(state.manifestPath, manifest);
			return { status: "complete", runDir: directory, proposalPath, ...(publishedPath ? { publishedPath } : {}) };
		});
	});
}

export async function abortCouncil(options) {
	const templates = await loadTemplates(options.templatesPath);
	const located = await validatedRunPath(options.cwd, options.run, safeRoots(options));
	return withRunLock(located.directory, async () => {
		const state = await loadRun(options);
		if (state.manifest.status === "complete") throw new CouncilError("Run is already complete");
		if (state.manifest.status !== "incomplete") await markIncomplete(state, templates, new Error(state.integrityError ?? `Aborted by the parent: ${options.reason || "no reason given"}`));
		const active = state.manifest.participants.filter((p) => p.active).map((p) => agentId(p.slot));
		return { status: "incomplete", runDir: state.directory, stop: { action: "stop", runDir: state.manifest.subagentRunDir, agentIds: active } };
	});
}

export async function councilStatus(options) {
	const templates = await loadTemplates(options.templatesPath);
	const state = await loadRun(options);
	const { manifest } = state;
	const recovery = state.integrityError ? {} : deliveryActions(state, templates, await undeliveredParticipants(state));
	const next = {
		running: "Wait for active participants, then collect.",
		reviewing_synthesis: "Wait for active participants, then collect round 5.",
		awaiting_synthesis: "Write the draft synthesis, then review --draft-file.",
		awaiting_finalization: "Write the corrected proposal and revision notes, then finalize.",
		complete: "Done. Report the proposal path.",
		incomplete: "Cannot continue. Inspect discussion.md; start a new run if needed.",
	}[manifest.status];
	return {
		status: manifest.status, round: manifest.round, mode: manifest.mode, runDir: state.directory,
		participantRunDir: manifest.subagentRunDir,
		participants: manifest.participants.map((p) => ({ agentId: agentId(p.slot), model: p.model, thinking: p.thinking, active: p.active, ...(p.active ? {} : { droppedRound: p.droppedRound, reason: p.dropReason }) })),
		...(manifest.error ? { error: manifest.error } : {}),
		...(state.integrityError ? { integrityError: state.integrityError } : {}),
		next: state.integrityError && manifest.status !== "incomplete" ? "Integrity failure: run abort, then report it." : recovery.respawn || recovery.resend ? "Deliver respawn/resend first (those participants never received this round), then wait and collect." : next,
		...recovery,
		...(["running", "reviewing_synthesis"].includes(manifest.status) ? { wait: waitAction(manifest) } : {}),
	};
}
