import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { councilResearchArgs } from "./research-tools.js";
import { loadSubagentConfig, shouldForceCurrentSubagentModel, stopAgents } from "../async-subagents/lib.js";
import type { BrainstormRound } from "./workflow.js";

interface CouncilTask {
	id: string;
	model: string;
	task: string;
	thinking: string;
	timeoutSeconds: number;
}

interface RoundRequest {
	round: BrainstormRound;
	tasks: CouncilTask[];
	signal?: AbortSignal;
}

const TERMINAL = new Set(["done", "failed", "stopped"]);

function abortIfNeeded(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Brainstorm cancelled.");
}

/** Reject overrides that could silently defeat the explicit council roster. */
export function preflightCouncil(ctx: Pick<ExtensionToolContext, "cwd" | "tools">): void {
	if (!ctx.tools.some((tool) => tool.name === "subagents")) throw new Error("Brainstorm requires the active async-subagents tool.");
	if (shouldForceCurrentSubagentModel()) throw new Error("Disable ASYNC_SUBAGENTS_FORCE_CURRENT_MODEL / PI_SUBAGENTS_FORCE_CURRENT_MODEL for brainstorm: the council requires exact configured models.");
	const profile = loadSubagentConfig(ctx.cwd).types.research;
	if (!profile) throw new Error("Brainstorm requires the research subagent role.");
	if (profile.extraArgs?.length) throw new Error("Brainstorm requires research.extraArgs to be empty; CLI overrides could change the council models or read-only tools.");
}

async function readBoundedResult(file: string): Promise<string> {
	const handle = await open(file, "r");
	try {
		const buffer = Buffer.alloc(64 * 1024 + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 64 * 1024) throw new Error(`Council response exceeds 64 KiB: ${file}`);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

export function createCouncilRunner(ctx: ExtensionToolContext) {
	return async ({ round, tasks, signal }: RoundRequest) => {
		abortIfNeeded(signal);
		preflightCouncil(ctx);
		const root = join(ctx.cwd, ".pi", "subagents");
		await mkdir(root, { recursive: true });
		const runDir = await mkdtemp(join(root, `brainstorm-r${round}-`));
		const ids = tasks.map((task) => task.id);
		const call = async (args: Record<string, unknown>) => {
			abortIfNeeded(signal);
			const outcome = await ctx.executeTool("subagents", { ...args, runDir }, { signal });
			abortIfNeeded(signal);
			if (outcome.isError) {
				throw new Error(outcome.result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n"));
			}
			return outcome.result.details;
		};
		try {
			await call({ action: "spawn", watchSeconds: 0, tasks: tasks.map((task) => ({
				...task, subagentType: "research", tools: ["read"],
				extraArgs: councilResearchArgs(),
				promptOverride: "{task}",
			})) });
			// Includes queue time; retries remain governed by async-subagents, but
			// cannot extend this council round indefinitely.
			const deadline = Date.now() + (tasks.reduce((total, task) => total + task.timeoutSeconds, 0) + 30) * 1000;
			// Wait for every participant: a failed/stopped/timed-out participant
			// becomes a declared gap; the workflow enforces the quorum.
			const statuses = new Map<string, string>();
			while (true) {
				const remaining = (deadline - Date.now()) / 1000;
				if (remaining <= 0) break;
				const details = await call({ action: "wait", agentIds: ids, timeout: Math.min(30, remaining), interval: 1 });
				const agents = details?.agents as Array<{ id: string; status: string }> | undefined;
				if (!agents || agents.length !== ids.length || new Set(agents.map((agent) => agent.id)).size !== ids.length ||
					agents.some((agent) => !ids.includes(agent.id))) throw new Error(`Incomplete council state: ${runDir}`);
				for (const agent of agents) statuses.set(agent.id, agent.status);
				if (agents.every((agent) => TERMINAL.has(agent.status))) break;
			}
			const pending = ids.filter((id) => !TERMINAL.has(statuses.get(id) ?? ""));
			if (pending.length) {
				const failures = stopAgents(runDir, pending).filter((stop) => stop.error);
				if (failures.length) throw new Error(`Round ${round} timed out and cancellation needs attention: ${failures.map((stop) => stop.error).join("; ")}\n${runDir}`);
			}
			const responses = [];
			const missing = [];
			for (const task of tasks) {
				const status = statuses.get(task.id);
				if (status !== "done") {
					missing.push({ id: task.id, model: task.model, reason: status && TERMINAL.has(status) ? `participant ${status}` : "timed out" });
					continue;
				}
				const details = await call({ action: "result", agentId: task.id });
				if (details?.state?.status !== "done" || details?.structured?.model !== task.model || details?.structured?.resultTruncated) {
					throw new Error(`Missing, substituted or truncated council response from ${task.id}: ${runDir}`);
				}
				const resultPath = join(runDir, task.id, "result.md");
				const text = await readBoundedResult(resultPath);
				abortIfNeeded(signal);
				if (!text.trim()) throw new Error(`Empty council response: ${resultPath}`);
				responses.push({ id: task.id, model: task.model, text, source: resultPath });
			}
			return { responses, missing };
		} catch (error) {
			// The SDK rejects nested work on a cancelled/stale tool context. Use
			// the shared ownership-aware cancellation primitive for our exact run.
			const stops = stopAgents(runDir, ids);
			const failures = stops.filter((stop) => stop.error);
			if (failures.length) throw new Error(`${String(error)}\nCancellation needs attention: ${failures.map((stop) => stop.error).join("; ")}\n${runDir}`);
			throw error;
		}
	};
}
