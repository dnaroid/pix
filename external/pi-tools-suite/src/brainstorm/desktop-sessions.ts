import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createCouncilRunner, preflightCouncil } from "./subagents.js";
import type { BrainstormExecution, RoundOutcome, RunRound, TerminalNotification } from "./workflow.js";

interface HostConnection { url: string; token: string }
const MAX_REPLY_BYTES = 2 * 1024 * 1024;

/** A capability is supplied by ACP, never by model tool arguments or a run file. */
export function desktopCouncilConnection(env: NodeJS.ProcessEnv = process.env): HostConnection | undefined {
	const url = env.PIX_BRAINSTORM_HOST_URL;
	const token = env.PIX_BRAINSTORM_HOST_TOKEN;
	if (!url && !token) return undefined;
	if (!url || !token) throw new Error("Incomplete Desktop brainstorm host capability; refusing fallback.");
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Desktop brainstorm host must be an authenticated loopback endpoint.");
	}
	return { url, token };
}

async function readReply(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Desktop brainstorm host returned no response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.length;
			if (bytes > MAX_REPLY_BYTES) throw new Error("Desktop brainstorm response exceeds 2 MiB.");
			chunks.push(next.value);
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!response.ok) throw new Error(`Desktop brainstorm host: ${typeof body?.error === "string" ? body.error.slice(0, 2000) : `HTTP ${response.status}`}`);
		return body;
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function request(host: HostConnection, body: unknown, signal: AbortSignal): Promise<unknown> {
	return readReply(await fetch(host.url, {
		method: "POST", redirect: "error", signal,
		headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	}));
}

/** Terminal notification is best effort: never turn a saved final proposal into
 * a false failure because the host disconnected. Failed release stays visible. */
export function desktopCouncilTerminal(notify: (message: string) => void, host = desktopCouncilConnection()): TerminalNotification {
	return async (runId, status) => {
		if (!host) {
			notify("Desktop brainstorm host unavailable; participant ownership release was not confirmed.");
			return;
		}
		try { await request(host, { action: "finish", runId, status }, AbortSignal.timeout(10_000)); }
		catch { notify("Desktop brainstorm participant ownership release failed; inspect the storm before writing to its sessions."); }
	};
}

/** The stored execution mode decides continuation. A Desktop run cannot fall
 * back to fresh TUI workers, and a legacy run cannot switch to empty sessions. */
export function createBrainstormRunner(ctx: ExtensionToolContext, host = desktopCouncilConnection()): RunRound {
	const validateExecution = (execution: BrainstormExecution | undefined) => {
		if (execution === "desktop-sessions") {
			if (!host) throw new Error("This council requires its original Desktop session host; fresh participants are not a continuation.");
		} else preflightCouncil(ctx);
	};
	const run: RunRound = async (input) => {
		validateExecution(input.execution);
		if (!input.execution) return createCouncilRunner(ctx)(input);
		if (!input.runId || !input.runDir || !input.topic) throw new Error("Desktop council requires its generated run identity.");
		const deadline = AbortSignal.timeout((input.tasks.reduce((sum, task) => sum + task.timeoutSeconds, 0) + 30) * 1000);
		const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
		const { runId, runDir, topic, round, tasks } = input;
		return await request(host!, { action: "round", runId, runDir, topic, round, tasks }, signal) as RoundOutcome;
	};
	run.execution = host ? "desktop-sessions" : undefined;
	run.validateExecution = validateExecution;
	run.onTerminal = desktopCouncilTerminal((message) => ctx.ui.notify(message, "warning"), host);
	return run;
}
