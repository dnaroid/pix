import { cleanObserverText, type ContextRecord } from "./context.js";

/** Versioned runtime-only suite bridge. No arbitrary custom transcript messages. */
export const DELEGATED_EVIDENCE_EVENT = "async-subagents:delegated-evidence";
interface Launch { launchId: string; sessionId: string; anchorId: string; agentId: string; }
interface Report { launch: Launch; record: ContextRecord; }
const LIMIT = 64;

export class DelegatedEvidence {
	private launches = new Map<string, Launch>();
	private reports = new Map<string, Report>();
	clear(): void { this.launches.clear(); this.reports.clear(); }
	accept(value: unknown, sessionId: string): boolean {
		if (!value || typeof value !== "object") return false;
		const data = value as Record<string, unknown>;
		if (data.version !== 1 || data.sessionId !== sessionId) return false;
		for (const key of ["launchId", "sessionId", "anchorId", "agentId"]) {
			if (typeof data[key] !== "string" || !data[key] || (data[key] as string).length > 128) return false;
		}
		const launch: Launch = { launchId: data.launchId as string, sessionId: data.sessionId as string, anchorId: data.anchorId as string, agentId: data.agentId as string };
		if (data.phase === "started") {
			if (!this.launches.has(launch.launchId) && !this.reports.has(launch.launchId)) this.launches.set(launch.launchId, launch);
			while (this.launches.size > LIMIT) this.launches.delete(this.launches.keys().next().value!);
			return false;
		}
		const original = this.launches.get(launch.launchId);
		if (!["completed", "retired"].includes(String(data.phase)) || !original || !["sessionId", "anchorId", "agentId"].every((key) => data[key] === original[key as keyof Launch])) return false;
		this.launches.delete(launch.launchId);
		if (data.phase === "retired") return false;
		if (typeof data.runDir !== "string" || !data.runDir || data.runDir.length > 1024 || !["done", "failed", "stopped"].includes(String(data.status)) || typeof data.report !== "string" || !data.report.trim()) return false;
		const raw = `Delegated work (child-reported, NOT verified mutation/test evidence).\nRun: ${data.runDir}\nChild: ${launch.agentId}\nParent spawn entry: ${launch.anchorId}\nProcess status: ${data.status}\n${data.report.slice(0, 6000)}`;
		const text = cleanObserverText(raw);
		this.reports.set(launch.launchId, { launch: original, record: { id: `delegated:${launch.launchId}`.slice(0, 128), kind: "delegated", text, clipped: data.clipped === true || text.length < raw.length } });
		while (this.reports.size > LIMIT) this.reports.delete(this.reports.keys().next().value!);
		return true;
	}
	records(projectedIds: ReadonlySet<string>): ContextRecord[] {
		return [...this.reports.values()].filter(({ launch }) => projectedIds.has(launch.anchorId)).map(({ record }) => record);
	}
}
