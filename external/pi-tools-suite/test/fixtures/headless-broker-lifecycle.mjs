import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runSubagentsBroker } from "../../src/headless/subagent-broker.ts";

const [runDir, finalStatus, receipt, mode] = process.argv.slice(2);
const exitFile = path.join(runDir, "agent", "exit_code");
const tasks = mode === "multiple" ? [{ id: "finished-first" }, { id: "agent" }] : [{ id: "agent" }];
let scheduled = false;
await runSubagentsBroker({
	async execute(_tool, params) {
		if (params.action === "spawn") {
			if (mode === "multiple") {
				mkdirSync(path.join(runDir, "finished-first"));
				writeFileSync(path.join(runDir, "finished-first", "exit_code"), "0");
			}
			return { content: [], details: { runDir, tasks } };
		}
		if (!scheduled) {
			scheduled = true;
			if (mode === "retry") writeFileSync(exitFile, "1");
			if (mode === "stale-status") {
				// The stopped snapshot below precedes a completion callback that
				// publishes failure + retry_pending in the same synchronous turn.
				queueMicrotask(() => writeFileSync(exitFile, "1"));
			}
			// Reproduce the post-taskkill window: no child/pipe handles remain,
			// and Pix's deferred completion callback is explicitly unreferenced.
			setTimeout(() => {
				if (mode === "cleanup") rmSync(runDir, { recursive: true, force: true });
				else {
					writeFileSync(exitFile, receipt);
					writeFileSync(path.join(runDir, "finalized"), "yes");
				}
			}, 100).unref();
			if (mode === "poll-error") throw new Error("controlled transient wait failure");
		}
		const finalized = existsSync(path.join(runDir, "finalized"));
		const retrying = mode === "retry" || (mode === "stale-status" && existsSync(exitFile));
		const status = finalized ? finalStatus : retrying ? "retrying" : "stopped";
		const agents = mode === "missing-agent" && !finalized ? [] : [{ id: "agent", status }];
		if (mode === "multiple") agents.unshift({ id: "finished-first", status: "done" });
		return { content: [], details: { agents } };
	},
}, { action: "spawn", tasks: mode === "resolved-id" ? [{}] : tasks }, path.join(runDir, "reply.json"));
