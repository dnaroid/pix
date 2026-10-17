import { writeFileSync } from "node:fs";
import path from "node:path";
import { runSubagentsBroker } from "../../src/headless/subagent-broker.ts";
import { runKey } from "../../src/async-subagents/core/paths.ts";
import { forgetRecord, getRecord, updateRecord } from "../../src/async-subagents/core/store.ts";

const [cwd, finalStatus, receipt, mode] = process.argv.slice(2);
const runDir = runKey(cwd, "11111111-1111-4111-8111-111111111111", "broker-batch");
const tasks = mode === "multiple" ? [{ id: "finished-first" }, { id: "agent" }] : [{ id: "agent" }];
const finish = (id, value, extra = {}) => updateRecord(runDir, id, value === "stopped"
	? { status: "stopped", finishedAt: new Date().toISOString(), ...extra }
	: { status: value === "0" ? "done" : "failed", exitCode: Number(value), finishedAt: new Date().toISOString(), ...extra });
let scheduled = false;
let finalized = false;
await runSubagentsBroker({
	async execute(_tool, params) {
		if (params.action === "spawn" || params.action === "send") {
			for (const task of tasks) updateRecord(runDir, task.id, { status: "running", turn: 1 });
			if (mode === "multiple") finish("finished-first", "0");
			return { content: [], details: mode === "resume" ? { runDir, delivery: "resume", agentId: "agent" } : { runDir, tasks } };
		}
		if (!scheduled) {
			scheduled = true;
			// A failed attempt whose retry is pending is not a final receipt.
			if (mode === "retry") finish("agent", "1", { status: "retrying" });
			if (mode === "stale-status") {
				// The stopped snapshot below precedes a completion callback that
				// publishes failure + a pending retry in the same synchronous turn.
				queueMicrotask(() => finish("agent", "1", { status: "retrying" }));
			}
			// Reproduce the post-taskkill window: no child/pipe handles remain,
			// and Pix's deferred completion callback is explicitly unreferenced.
			setTimeout(() => {
				if (mode === "cleanup") for (const task of tasks) forgetRecord(runDir, task.id);
				else {
					finish("agent", receipt);
					finalized = true;
				}
			}, 100).unref();
			if (mode === "poll-error") throw new Error("controlled transient wait failure");
		}
		const retrying = mode === "retry" || (mode === "stale-status" && getRecord(runDir, "agent")?.status === "retrying");
		const status = finalized ? finalStatus : retrying ? "retrying" : "stopped";
		const agents = mode === "missing-agent" && !finalized ? [] : [{ id: "agent", status }];
		if (mode === "multiple") agents.unshift({ id: "finished-first", status: "done" });
		return { content: [], details: { agents } };
	},
}, { action: mode === "resume" ? "send" : "spawn", tasks: mode === "resolved-id" ? [{}] : tasks }, path.join(cwd, "reply.json"));
const record = getRecord(runDir, "agent");
const observed = !record ? "removed" : record.status === "stopped" ? "stopped" : String(record.exitCode);
writeFileSync(path.join(cwd, "observed-receipt"), observed);
