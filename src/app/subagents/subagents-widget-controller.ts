import { resolve } from "node:path";
import { stringifyUnknown } from "../rendering/message-content.js";
import {
	activeSubagentStates,
	isSubagentRunRenderDetails,
	isSubagentsLiveStateEvent,
	isSubagentsToolName,
	resolveSubagentRunDir,
} from "./subagents-model.js";
import type { SubagentRunRenderDetails, SubagentsWidgetState, SubagentTaskPreview } from "../types.js";

export type SubagentsToolResultObserveOptions = {
	showSnapshot?: boolean;
};

export type SubagentsWidgetControllerHost = {
	readonly cwd: string;
	hasActiveRuntime(): boolean;
	sessionFile(): string | undefined;
	isRunning(): boolean;
	render(): void;
};

/**
 * Widget state for the current session's active sub-agents. Sub-agent state
 * lives in the parent/child sessions (decision 0072); the in-process suite
 * publishes it through live-state events (including after session restore),
 * so this controller reads no files and runs no poller.
 */
export class AppSubagentsWidgetController {
	private currentRunDir: string | undefined;
	private currentRunDirs: string[] = [];
	private state: SubagentsWidgetState | undefined;
	private readonly runFreshnessByRunDir = new Map<string, number>();
	private readonly taskPreviewsByRunDir = new Map<string, SubagentTaskPreview[]>();

	constructor(private readonly host: SubagentsWidgetControllerHost) {}

	get widgetState(): SubagentsWidgetState | undefined {
		if (!this.host.hasActiveRuntime()) return undefined;
		return this.state;
	}

	reset(): void {
		this.currentRunDir = undefined;
		this.currentRunDirs = [];
		this.runFreshnessByRunDir.clear();
		this.taskPreviewsByRunDir.clear();
		this.updateState(undefined);
	}

	observeToolResult(toolName: string, details: unknown, options: SubagentsToolResultObserveOptions = {}): void {
		if (!isSubagentsToolName(toolName)) return;
		if (!isSubagentRunRenderDetails(details)) return;
		if (!this.host.hasActiveRuntime()) return;

		const runDir = resolveSubagentRunDir(this.host.cwd, details.runDir);
		const normalizedDetails: SubagentRunRenderDetails = { ...details, runDir };
		if (normalizedDetails.tasks) this.taskPreviewsByRunDir.set(runDir, normalizedDetails.tasks);

		// Historical (replayed) results never resurrect a widget; live-state
		// events own the current session's active runs.
		if (options.showSnapshot === false) return;

		this.currentRunDir = runDir;
		this.rememberRunFreshness(runDir, this.runFreshnessFromAgents(normalizedDetails.agents) ?? Date.now());

		if (activeSubagentStates(normalizedDetails.agents).length > 0) {
			this.currentRunDirs = this.orderRunDirs([runDir, ...this.currentRunDirs]);
			this.updateState(this.buildStateFromRuns([normalizedDetails], {
				live: false,
				snapshotOnly: true,
				checkedAt: Date.now(),
			}));
		}
	}

	observeLiveState(data: unknown): void {
		if (!isSubagentsLiveStateEvent(data)) return;
		if (!this.eventMatchesCurrentSession(data.sessionFile)) return;

		const activeRuns = data.runs
			.map((run) => ({
				runDir: resolveSubagentRunDir(this.host.cwd, run.runDir),
				agents: run.agents,
				...(run.tasks === undefined ? {} : { tasks: run.tasks }),
			}))
			.filter((run) => activeSubagentStates(run.agents).length > 0);

		for (const run of activeRuns) {
			this.rememberRunFreshness(run.runDir, this.runFreshnessFromAgents(run.agents) ?? data.checkedAt);
			if (run.tasks) this.taskPreviewsByRunDir.set(run.runDir, run.tasks);
		}

		if (activeRuns.length === 0) {
			this.currentRunDir = undefined;
			this.currentRunDirs = [];
			this.runFreshnessByRunDir.clear();
			this.taskPreviewsByRunDir.clear();
			this.updateState(undefined);
			return;
		}

		const runs = activeRuns.map((run): SubagentRunRenderDetails => {
			const cached = run.tasks === undefined ? this.taskPreviewsByRunDir.get(run.runDir) : undefined;
			return cached ? { ...run, tasks: cached } : run;
		});
		const orderedRuns = this.orderRuns(runs);
		this.currentRunDir = orderedRuns[0]?.runDir;
		this.currentRunDirs = orderedRuns.map((run) => run.runDir);
		this.updateState(this.buildStateFromRuns(orderedRuns, {
			live: true,
			snapshotOnly: false,
			checkedAt: data.checkedAt,
		}));
	}

	private buildStateFromRuns(
		runs: readonly SubagentRunRenderDetails[],
		meta: Pick<SubagentsWidgetState, "live" | "snapshotOnly" | "checkedAt">,
	): SubagentsWidgetState | undefined {
		const activeRuns = runs
			.map((run) => ({ ...run, agents: activeSubagentStates(run.agents) }))
			.filter((run) => run.agents.length > 0);
		if (activeRuns.length === 0) return undefined;

		const primary = activeRuns[0];
		if (!primary) return undefined;
		return {
			runs: activeRuns.map((run) => ({
				runDir: run.runDir,
				agents: run.agents,
				...(run.tasks === undefined ? {} : { tasks: run.tasks }),
			})),
			runDir: primary.runDir,
			agents: activeRuns.flatMap((run) => run.agents),
			...(primary.tasks === undefined ? {} : { tasks: primary.tasks }),
			...meta,
		};
	}

	private orderRuns(runs: readonly SubagentRunRenderDetails[]): SubagentRunRenderDetails[] {
		const order = this.orderRunDirs(runs.map((run) => run.runDir));
		const priority = new Map(order.map((runDir, index) => [runDir, index]));
		return [...runs].sort((a, b) => {
			const freshness = this.runFreshness(b) - this.runFreshness(a);
			if (freshness !== 0) return freshness;
			return (priority.get(a.runDir) ?? Number.MAX_SAFE_INTEGER) - (priority.get(b.runDir) ?? Number.MAX_SAFE_INTEGER);
		});
	}

	private orderRunDirs(runDirs: readonly string[]): string[] {
		const seen = new Set<string>();
		const preferred = [this.currentRunDir, ...this.currentRunDirs, ...runDirs].filter((runDir): runDir is string => Boolean(runDir));
		const ordered: string[] = [];
		for (const runDir of preferred) {
			if (seen.has(runDir)) continue;
			seen.add(runDir);
			ordered.push(runDir);
		}
		return ordered;
	}

	private rememberRunFreshness(runDir: string, freshness: number | undefined): void {
		if (!Number.isFinite(freshness)) return;
		const next = freshness ?? 0;
		const previous = this.runFreshnessByRunDir.get(runDir) ?? Number.NEGATIVE_INFINITY;
		if (next >= previous) this.runFreshnessByRunDir.set(runDir, next);
	}

	private runFreshness(run: SubagentRunRenderDetails): number {
		return this.runFreshnessFromAgents(run.agents)
			?? this.runFreshnessByRunDir.get(run.runDir)
			?? 0;
	}

	private runFreshnessFromAgents(agents: readonly { startedAt?: string }[]): number | undefined {
		let freshest: number | undefined;
		for (const agent of agents) {
			const parsed = this.parseRunTimestamp(agent.startedAt);
			if (parsed === undefined) continue;
			freshest = freshest === undefined ? parsed : Math.max(freshest, parsed);
		}
		return freshest;
	}

	private parseRunTimestamp(value: string | undefined): number | undefined {
		if (!value) return undefined;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private updateState(next: SubagentsWidgetState | undefined): void {
		const previous = stringifyUnknown(this.state);
		const serializedNext = stringifyUnknown(next);
		this.state = next;
		if (previous !== serializedNext && this.host.isRunning()) this.host.render();
	}

	private eventMatchesCurrentSession(eventSessionFile: string | undefined): boolean {
		if (!this.host.hasActiveRuntime()) return false;
		if (!eventSessionFile) return true;
		const sessionFile = this.host.sessionFile();
		if (!sessionFile) return true;
		return resolve(eventSessionFile) === resolve(sessionFile);
	}
}
