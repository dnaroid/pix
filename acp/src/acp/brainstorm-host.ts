import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { PIX_BRAINSTORM_CHANNEL } from "./session-state-bridge.js";

export const BRAINSTORM_CHANNEL = PIX_BRAINSTORM_CHANNEL;
export interface BrainstormLink { runId: string; parentSessionId: string; slot: number; owned: boolean }
export interface BrainstormParticipant {
	slot: number; sessionId: string; name: string; model: string;
	status: "planned" | "running" | "done" | "failed" | "stopped"; round: number;
}
export interface BrainstormRun {
	runId: string; runDir: string; topic: string;
	status: "running" | "awaiting_synthesis" | "awaiting_finalization" | "complete" | "incomplete";
	round: number; participants: BrainstormParticipant[];
}
export interface BrainstormTask { id: string; model: string; task: string; thinking: string; timeoutSeconds: number }
export interface BrainstormRound { action: "round"; runId: string; runDir: string; topic: string; round: number; tasks: BrainstormTask[] }
interface OwnedRun { parent: string; view: BrainstormRun; busy: boolean; controller?: AbortController; finishing?: Promise<void>; releasing?: boolean }
export interface BrainstormHostBackend {
	create(parent: string, participant: BrainstormParticipant, link: BrainstormLink, signal: AbortSignal): Promise<void>;
	round(participant: BrainstormParticipant, task: BrainstormTask, signal: AbortSignal): Promise<string>;
	stop(sessionId: string): Promise<void>;
	link(sessionId: string, link: BrainstormLink): Promise<void>;
	publish(parent: string, snapshot: { version: 1; checkedAt: number; runs: BrainstormRun[] }): Promise<void>;
}

/** Desktop-only capability host. No title-derived ownership, replacement, or resume. */
export class BrainstormHost {
	private readonly tokens = new Map<string, string>();
	private readonly runs = new Map<string, OwnedRun>();
	private readonly operations = new Set<Promise<unknown>>();
	private server?: Server;
	private listening?: Promise<string>;
	private closed = false;
	constructor(private readonly backend: BrainstormHostBackend, private readonly deadline: (seconds: number) => AbortSignal = (seconds) => AbortSignal.timeout(seconds * 1000)) {}

	async environment(parent: string): Promise<Record<string, string>> {
		if (this.closed) throw new Error("brainstorm host is closed");
		const url = await (this.listening ??= this.listen());
		if (this.closed) throw new Error("brainstorm host is closed");
		let token = [...this.tokens].find(([, owner]) => owner === parent)?.[0];
		if (!token) { token = randomBytes(32).toString("hex"); this.tokens.set(token, parent); }
		return { PIX_BRAINSTORM_HOST_URL: url, PIX_BRAINSTORM_HOST_TOKEN: token };
	}

	metadata(sessionId: string): BrainstormLink | undefined {
		for (const run of this.runs.values()) {
			const p = run.view.participants.find((p) => p.sessionId === sessionId);
			if (p) return { runId: run.view.runId, parentSessionId: run.parent, slot: p.slot, owned: !terminal(run.view) || run.releasing === true };
		}
		return undefined;
	}

	ownsRuns(parent: string): boolean {
		return [...this.runs.values()].some((run) => run.parent === parent && (!terminal(run.view) || run.releasing));
	}

	async participantLost(sessionId: string): Promise<void> {
		for (const run of this.runs.values()) {
			const p = run.view.participants.find((p) => p.sessionId === sessionId);
			if (p && !terminal(run.view)) { p.status = "failed"; await this.publish(run); return; }
		}
	}

	async cancelParent(parent: string, revoke = false): Promise<void> {
		if (revoke) for (const [token, owner] of this.tokens) if (owner === parent) this.tokens.delete(token);
		await Promise.all([...this.runs.values()].filter((run) => run.parent === parent && (!terminal(run.view) || run.releasing))
			.map((run) => this.finish(run, "incomplete")));
	}

	async dispose(): Promise<void> {
		this.closed = true;
		this.tokens.clear();
		await this.listening?.catch(() => {});
		this.server?.closeAllConnections();
		await Promise.all([...this.runs.values()].filter((run) => !terminal(run.view) || run.releasing).map((run) => this.finish(run, "incomplete")));
		await Promise.allSettled([...this.operations]);
		if (this.server) {
			this.server.closeAllConnections();
			await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		}
	}

	private async listen(): Promise<string> {
		const server = this.server = createServer((req, res) => {
			const operation = (async () => {
				const controller = new AbortController();
				const abort = () => controller.abort(new Error("brainstorm caller disconnected"));
				res.on("close", abort);
				try {
					if (req.method !== "POST" || req.url !== "/") throw new Error("POST / required");
					const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
					const parent = token && this.tokens.get(token);
					if (!parent || this.closed) { res.writeHead(403); res.end(JSON.stringify({ error: "invalid brainstorm capability" })); return; }
					let size = 0;
					const chunks: Buffer[] = [];
					for await (const chunk of req) {
						size += Buffer.byteLength(chunk);
                        // Six bounded prompts may each include the 200k draft plus
                        // 200k peer evidence; allow JSON escaping without truncation.
                        if (size > 16 * 1024 * 1024) throw new Error("brainstorm request exceeds 16 MiB");
						chunks.push(Buffer.from(chunk));
					}
					controller.signal.throwIfAborted();
					if (this.closed || this.tokens.get(token!) !== parent) throw new Error("brainstorm capability revoked");
					const result = await this.dispatch(parent, JSON.parse(Buffer.concat(chunks).toString("utf8")), controller.signal);
					res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result));
				} catch (error) {
					if (!res.destroyed) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: message(error) })); }
				} finally { res.off("close", abort); }
			})();
			this.operations.add(operation);
			void operation.finally(() => this.operations.delete(operation));
		});
		server.requestTimeout = 30_000;
		server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
		server.unref();
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("brainstorm host failed to bind");
		return `http://127.0.0.1:${address.port}/`;
	}

	private async dispatch(parent: string, body: unknown, signal: AbortSignal): Promise<unknown> {
		if (!record(body) || typeof body.runId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(body.runId)) throw new Error("invalid runId");
		let run = this.runs.get(body.runId);
		if (run && run.parent !== parent) throw new Error("brainstorm run belongs to another parent");
		if (body.action === "finish") {
			if (!run || (body.status !== "complete" && body.status !== "incomplete")) throw new Error("invalid brainstorm finish");
			if (body.status === "complete" && (run.busy || run.view.round !== 5)) throw new Error("brainstorm review has not settled");
			await this.finish(run, body.status); return {};
		}
		const request = parseRound(body);
		if (!run) {
			if (request.round !== 1) throw new Error("brainstorm sessions lost; cannot resume or replace");
			if ([...this.runs.values()].filter((r) => r.parent === parent).length >= 64) throw new Error("brainstorm run limit reached");
			run = { parent, busy: false, view: { runId: request.runId, runDir: request.runDir, topic: request.topic, round: 0, status: "running",
				participants: request.tasks.map((task) => { const slot = taskSlot(task.id, request.round); return { slot, sessionId: randomUUID(), name: `[BS:${request.runId}] P${slot} ${task.model}`, model: task.model, status: "planned", round: 0 }; }) } };
			this.runs.set(request.runId, run);
		}
		if (terminal(run.view) || run.busy || request.round !== run.view.round + 1) throw new Error("brainstorm round is not the next idle round");
		if (run.view.runDir !== request.runDir || run.view.topic !== request.topic || request.tasks.length !== run.view.participants.length
			|| request.tasks.some((task) => !run!.view.participants.some((p) => p.slot === taskSlot(task.id, request.round) && p.model === task.model))) throw new Error("brainstorm roster or run identity changed");
		const owned = run;
		owned.busy = true;
		owned.controller = new AbortController();
		const abort = () => owned.controller?.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		owned.view.round = request.round;
		owned.view.status = "running";
		const responses: { id: string; model: string; text: string; source?: string }[] = [];
		const missing: { id: string; model: string; reason: string }[] = [];
		try {
			await this.publish(owned);
			await Promise.all(request.tasks.map(async (task) => {
				const p = owned.view.participants.find((p) => p.slot === taskSlot(task.id, request.round))!;
				const deadline = this.deadline(task.timeoutSeconds);
				const workSignal = AbortSignal.any([owned.controller!.signal, deadline]);
				try {
					if (p.status === "failed" || p.status === "stopped") throw new Error("participant session lost; no replacement permitted");
					p.round = request.round; p.status = "running";
					await this.publish(owned);
					const text = await abortable((async () => {
						workSignal.throwIfAborted();
						if (request.round === 1) await this.backend.create(parent, p, this.metadata(p.sessionId)!, workSignal);
						workSignal.throwIfAborted();
						return this.backend.round(p, task, workSignal);
					})(), workSignal);
					workSignal.throwIfAborted();
					if (terminal(owned.view)) throw new Error("brainstorm finished before response");
					if (!text.trim() || text.length > 40_000) throw new Error("participant response empty or exceeds 40,000 characters");
					p.status = "done";
					responses.push({ id: task.id, model: task.model, text, source: p.sessionId });
				} catch (error) {
					p.status = workSignal.aborted ? "stopped" : "failed";
					await this.backend.stop(p.sessionId);
					missing.push({ id: task.id, model: task.model, reason: message(error) });
				} finally { await this.publish(owned); }
			}));
			if (owned.controller.signal.aborted) await this.finish(owned, "incomplete");
			else owned.view.status = request.round === 4 ? "awaiting_synthesis" : request.round === 5 ? "awaiting_finalization" : "running";
			return { responses, missing };
		} finally {
			owned.busy = false; delete owned.controller; signal.removeEventListener("abort", abort); await this.publish(owned);
		}
	}

	private async finish(run: OwnedRun, status: "complete" | "incomplete"): Promise<void> {
		if (run.finishing) return run.finishing;
		if (terminal(run.view)) return;
		run.controller?.abort(new Error("brainstorm finished"));
		run.releasing = true;
		run.view.status = status;
		run.finishing = (async () => {
			await Promise.all(run.view.participants.map(async (p) => {
				await this.backend.stop(p.sessionId);
				if (p.status === "running" || p.status === "planned") p.status = "stopped";
			}));
			// Keep the live mutation guard locked until every durable link is
			// released; otherwise delete/fork/load can race these writes.
			await Promise.all(run.view.participants.map((p) => this.backend.link(p.sessionId, { ...this.metadata(p.sessionId)!, owned: false })));
			run.releasing = false;
			await this.publish(run);
		})();
		await run.finishing;
	}
	private publish(run: OwnedRun): Promise<void> {
		return this.backend.publish(run.parent, { version: 1, checkedAt: Date.now(), runs: structuredClone([...this.runs.values()].filter((r) => r.parent === run.parent).map((r) => r.view)) });
	}
}

function terminal(run: BrainstormRun): boolean { return run.status === "complete" || run.status === "incomplete"; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 1000); }
function taskSlot(id: string, round: number): number {
	const match = new RegExp(`^round-${round}-participant-([1-9][0-9]*)$`).exec(id);
	if (!match || Number(match[1]) > 6) throw new Error("invalid participant task id");
	return Number(match[1]);
}
function parseRound(body: Record<string, unknown>): BrainstormRound {
	if (body.action !== "round" || !Number.isInteger(body.round) || Number(body.round) < 1 || Number(body.round) > 5
		|| typeof body.runDir !== "string" || !isAbsolute(body.runDir) || body.runDir.length > 4096
		|| typeof body.topic !== "string" || body.topic.length > 40_000 || !Array.isArray(body.tasks) || !body.tasks.length || body.tasks.length > 6) throw new Error("invalid brainstorm round");
	const slots = new Set<number>();
	for (const task of body.tasks) {
		if (!record(task) || typeof task.id !== "string" || typeof task.model !== "string" || !/^[^\s/]+\/\S+$/.test(task.model) || task.model.length > 256
			|| typeof task.task !== "string" || !task.task.trim() || task.task.length > 450_000 || typeof task.thinking !== "string"
			|| !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(task.thinking)
			|| typeof task.timeoutSeconds !== "number" || !Number.isFinite(task.timeoutSeconds) || task.timeoutSeconds <= 0 || task.timeoutSeconds > 3600) throw new Error("invalid brainstorm task");
		const slot = taskSlot(task.id, Number(body.round));
		if (slots.has(slot)) throw new Error("duplicate participant slot"); slots.add(slot);
	}
	return body as unknown as BrainstormRound;
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	let abort: (() => void) | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason ?? new Error("brainstorm aborted"));
			signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
		})]);
	} finally { if (abort) signal.removeEventListener("abort", abort); }
}
