import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, basename, dirname } from "node:path";

type RecordLine = Record<string, any>;

export function localNode(): string {
	// Bun runs the tests; PATH is used only to locate an executable, never to run a shell.
	// Resolve links before probing; the probe has no inherited NODE_OPTIONS/preloads.
	const candidates = [process.execPath, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "node"))];
	for (const candidate of candidates) {
		if (basename(candidate) !== "node" || !existsSync(candidate)) continue;
		const node = realpathSync(candidate);
		if (!statSync(node).isFile()) continue;
		try {
			if (execFileSync(node, ["-p", "process.execPath"], {
				env: { PATH: dirname(node), LANG: "C" }, timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
			}).toString().trim() === node) return node;
		} catch { /* try the next local candidate */ }
	}
	throw new Error("No local Node executable found for the offline Pi fixture");
}

export async function rpcProbe(child: ChildProcess, deadlineMs = 12_000): Promise<RecordLine[]> {
	let stdout = "";
	let stderr = "";
	let buffer = "";
	let failure: Error | undefined;
	let closed = false;
	let wake: (() => void) | undefined;
	const records: RecordLine[] = [];
	const pending = new Set<(error: Error) => void>();
	const notify = () => { wake?.(); wake = undefined; };
	const fail = (error: Error) => {
		failure ??= error;
		for (const reject of pending) reject(failure);
		pending.clear();
		notify();
	};
	const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("close", (code, signal) => {
			closed = true; resolve({ code, signal });
			if (!records.some((r) => r.id === "messages") || !records.some((r) => r.type === "agent_settled"))
				fail(new Error(`Pi closed before RPC completion: ${JSON.stringify({ code, signal })}; stderr=${stderr}; stdout=${stdout.slice(-4000)}`));
			else notify();
		});
	});
	child.on("error", (error) => fail(error));
	child.stdin!.on("error", (error) => fail(error));
	child.stdout!.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
		if (stdout.length > 512_000) { fail(new Error("Pi RPC stdout limit exceeded")); return; }
		buffer += chunk.toString("utf8");
		let end: number;
		while ((end = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
			if (!line) continue;
			try { records.push(JSON.parse(line)); } catch { /* captured stdout appears in failure */ }
		}
		notify();
	});
	child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-16000); });
	const deadline = setTimeout(() => fail(new Error(`Pi RPC deadline exceeded; stderr=${stderr}; stdout=${stdout.slice(-4000)}`)), deadlineMs);
	const waitFor = async (predicate: () => boolean) => {
		while (!predicate()) {
			if (failure) throw failure;
			if (closed) throw new Error(`Pi closed before RPC response; stderr=${stderr}; stdout=${stdout.slice(-4000)}`);
			await new Promise<void>((resolve) => { wake = resolve; });
		}
		if (failure) throw failure;
	};
	const send = (id: string, type: string, extra: RecordLine = {}) => new Promise<void>((resolve, reject) => {
		if (failure || closed) { reject(failure ?? new Error("Pi closed before stdin write")); return; }
		const onFailure = (error: Error) => reject(error);
		pending.add(onFailure);
		child.stdin!.write(`${JSON.stringify({ id, type, ...extra })}\n`, (error) => {
			pending.delete(onFailure);
			if (error) reject(error);
			else if (failure) reject(failure);
			else resolve();
		});
	});
	try {
		await send("state", "get_state");
		await send("models", "get_available_models");
		await send("prompt", "prompt", { message: "offline transport probe" });
		await waitFor(() => records.some((r) => r.type === "agent_settled"));
		await send("messages", "get_messages");
		await waitFor(() => records.some((r) => r.id === "messages"));
		child.stdin!.end();
		await waitFor(() => closed);
		const exit = await close;
		if (exit.code !== 0 || exit.signal || failure) throw new Error(`Pi RPC exit ${JSON.stringify(exit)}; stderr=${stderr}; stdout=${stdout.slice(-4000)}; error=${failure}`);
		return records;
	} finally { clearTimeout(deadline); }
}

export async function stopAndConfirm(child: ChildProcess | undefined, close: Promise<unknown> | undefined, home: string, actorWaitMs = 10_000, expectedActors = 0): Promise<void> {
	if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	if (close) {
		// This promise is installed immediately after spawn and cannot miss an early close.
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Pi close not confirmed; retaining offline workdir")), 2000);
			close.then(() => { clearTimeout(timer); resolve(); });
		});
	}
	// Every fake launch records its private nonce before work and its exit synchronously.
	// Never send termination signals using these records. A signal-0 liveness probe
	// can conservatively reject a reused PID, but cannot kill its new owner. Require
	// the expected launch count: an empty directory or fixed startup delay cannot
	// prove an already-spawned fake has reached its first JavaScript instruction.
	const end = Date.now() + actorWaitMs;
	while (true) {
		const actors = existsSync(home) ? readdirSync(home).filter((name) => name.startsWith("fake-actor-")) : [];
		if (actors.length >= expectedActors && actors.every((name) => {
			if (name.endsWith(".tmp")) return false;
			const actor = JSON.parse(readFileSync(join(home, name), "utf8"));
			if (actor.exited !== true || !Number.isSafeInteger(actor.pid) || actor.pid <= 1) return false;
			try { process.kill(actor.pid, 0); return false; }
			catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		})) return;
		if (Date.now() >= end) throw new Error(`Fake actor exit not confirmed (${actors.join(", ")}); retaining offline workdir`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
