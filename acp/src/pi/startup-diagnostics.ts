const PREFIX = "[pix-startup] ";
const STAGES = ["sdk-import", "model-runtime", "resources", "session-start"] as const;
type Stage = typeof STAGES[number];
type Progress = { stage: Stage; status: "started" | "completed" | "failed"; elapsedMs: number };

/** Fixed metadata only: never serialize resource contents, credentials or errors. */
export async function traceRpcStartup<T>(
	stage: Stage,
	run: () => Promise<T>,
	report: (progress: Progress) => void,
): Promise<T> {
	const started = performance.now();
	const emit = (status: Progress["status"]) => {
		try { report({ stage, status, elapsedMs: Math.round(performance.now() - started) }); }
		catch { /* Diagnostics must not change startup behavior. */ }
	};
	emit("started");
	try {
		const result = await run();
		emit("completed");
		return result;
	} catch (error) {
		emit("failed");
		throw error;
	}
}

export function formatRpcStartupProgress(progress: Progress): string {
	return `${PREFIX}${JSON.stringify(progress)}\n`;
}

/** The SDK bounds get_state, but its timeout omits which startup phase blocked it. */
export function rpcStartupFailure(error: unknown, stderr: string): Error {
	const active: Stage[] = [];
	let latest: Progress | undefined;
	for (const line of stderr.split("\n")) {
		if (!line.startsWith(PREFIX)) continue;
		try {
			const value = JSON.parse(line.slice(PREFIX.length)) as Progress;
			if (!STAGES.includes(value.stage) || !["started", "completed", "failed"].includes(value.status)
				|| !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0) continue;
			latest = value;
			if (value.status === "started") active.push(value.stage);
			else {
				const index = active.lastIndexOf(value.stage);
				if (index >= 0) active.splice(index, 1);
			}
		} catch { /* Ignore unrelated/malformed stderr. */ }
	}
	const message = error instanceof Error ? error.message : String(error);
	const stage = active.at(-1);
	return new Error(`Pi RPC readiness failed: ${message}${stage ? `; startup stage: ${stage}`
		: latest ? `; last startup stage: ${latest.stage} (${latest.status}, ${latest.elapsedMs}ms)` : ""}`, { cause: error });
}
