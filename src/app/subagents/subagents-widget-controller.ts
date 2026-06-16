import { watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { SUBAGENTS_POLL_INTERVAL_MS, SUBAGENTS_RUN_ROOT } from "../constants.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import { readSubagentRegistry, readSubagentRunStateFromFiles, subagentRunHasParentSession } from "./subagents-files.js";
import {
	activeSubagentStates,
	allSubagentStatesTerminal,
	isSubagentRunRenderDetails,
	isSubagentsLiveStateEvent,
	isSubagentsToolName,
	resolveSubagentRunDir,
} from "./subagents-model.js";
import type { SubagentRunRenderDetails, SubagentsWidgetState, SubagentTaskPreview } from "../types.js";
import type { SubagentRegistry } from "../types.js";

const SUBAGENTS_FILE_WATCH_DEBOUNCE_MS = 75;

export type SubagentsToolResultObserveOptions = {
	showSnapshot?: boolean;
};

export type SubagentsWidgetControllerHost = {
	readonly cwd: string;
	sessionFile(): string | undefined;
	isRunning(): boolean;
	render(): void;
};

export class AppSubagentsWidgetController {
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private pollInFlight = false;
	private currentRunDir: string | undefined;
	private currentRunDirs: string[] = [];
	private state: SubagentsWidgetState | undefined;
	private readonly runFreshnessByRunDir = new Map<string, number>();
	private readonly taskPreviewsByRunDir = new Map<string, SubagentTaskPreview[]>();
	private readonly snapshotByRunDir = new Map<string, SubagentRunRenderDetails>();
	private refreshGeneration = 0;
	private fileWatcher: FSWatcher | undefined;
	private fileRefreshTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly host: SubagentsWidgetControllerHost) {}

	get widgetState(): SubagentsWidgetState | undefined {
		return this.state;
	}

	startPolling(): void {
		this.startFileWatcher();
		this.schedulePoll(0);
	}

	stopPolling(): void {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
		if (this.fileRefreshTimer) clearTimeout(this.fileRefreshTimer);
		this.fileRefreshTimer = undefined;
		this.stopFileWatcher();
	}

	reset(): void {
		this.refreshGeneration++;
		this.currentRunDir = undefined;
		this.currentRunDirs = [];
		this.runFreshnessByRunDir.clear();
		this.taskPreviewsByRunDir.clear();
		this.snapshotByRunDir.clear();
		this.updateState(undefined);
	}

	observeToolResult(toolName: string, details: unknown, options: SubagentsToolResultObserveOptions = {}): void {
		if (!isSubagentsToolName(toolName)) return;
		if (!isSubagentRunRenderDetails(details)) return;

		const runDir = resolveSubagentRunDir(this.host.cwd, details.runDir);
		const normalizedDetails: SubagentRunRenderDetails = { ...details, runDir };
		if (normalizedDetails.tasks) this.taskPreviewsByRunDir.set(runDir, normalizedDetails.tasks);

		if (options.showSnapshot === false) {
			void this.refreshFromFiles(this.refreshGeneration);
			this.schedulePoll(0);
			this.startFileWatcher();
			return;
		}

		this.currentRunDir = runDir;
		this.snapshotByRunDir.set(runDir, normalizedDetails);
		this.rememberRunFreshness(runDir, this.runFreshnessFromAgents(normalizedDetails.agents) ?? Date.now());

		if (activeSubagentStates(normalizedDetails.agents).length > 0) {
			this.currentRunDirs = this.orderRunDirs([runDir, ...this.currentRunDirs]);
			this.updateState(this.buildStateFromRuns([normalizedDetails], {
				live: false,
				snapshotOnly: true,
				checkedAt: Date.now(),
			}));
		}

		void this.refreshFromFiles(this.refreshGeneration);
		this.schedulePoll(0);
		if (this.host.isRunning()) this.host.render();
		this.startFileWatcher();
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
			this.snapshotByRunDir.set(run.runDir, {
				runDir: run.runDir,
				agents: run.agents,
				...(run.tasks === undefined ? {} : { tasks: run.tasks }),
				mode: "status",
			});
			if (run.tasks) this.taskPreviewsByRunDir.set(run.runDir, run.tasks);
		}

		if (activeRuns.length === 0) {
			this.currentRunDir = undefined;
			this.currentRunDirs = [];
			this.updateState(undefined);
			this.stopPolling();
			return;
		}

		const orderedRuns = this.orderRuns(activeRuns);
		this.currentRunDir = orderedRuns[0]?.runDir;
		this.currentRunDirs = orderedRuns.map((run) => run.runDir);
		this.updateState(this.buildStateFromRuns(orderedRuns, {
			live: true,
			snapshotOnly: false,
			checkedAt: data.checkedAt,
		}));
		this.startFileWatcher();
		this.schedulePoll(SUBAGENTS_POLL_INTERVAL_MS);
	}

	private startFileWatcher(): void {
		if (this.fileWatcher || !this.host.isRunning()) return;

		try {
			this.fileWatcher = watch(join(this.host.cwd, SUBAGENTS_RUN_ROOT), { recursive: true }, () => {
				this.handleSubagentsFilesChanged();
			});
			this.fileWatcher.on("error", () => this.stopFileWatcher());
		} catch {
			// The subagents directory may not exist yet, or recursive watching may be
			// unavailable on this platform. Polling and live-state events remain as
			// fallbacks; observeToolResult/liveState will retry once subagents exist.
			this.fileWatcher = undefined;
		}
	}

	private stopFileWatcher(): void {
		this.fileWatcher?.close();
		this.fileWatcher = undefined;
	}

	private handleSubagentsFilesChanged(): void {
		if (!this.host.isRunning()) return;
		if (this.fileRefreshTimer) clearTimeout(this.fileRefreshTimer);
		this.fileRefreshTimer = setTimeout(() => {
			this.fileRefreshTimer = undefined;
			const generation = this.refreshGeneration;
			void this.refreshFromFiles(generation).then(() => {
				if (this.isCurrentGeneration(generation) && this.shouldContinuePolling()) {
					this.schedulePoll(SUBAGENTS_POLL_INTERVAL_MS);
				}
			});
		}, SUBAGENTS_FILE_WATCH_DEBOUNCE_MS);
		this.fileRefreshTimer.unref?.();
	}

	private schedulePoll(delayMs: number): void {
		if (!this.host.isRunning()) return;
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			void this.poll();
		}, delayMs);
		this.pollTimer.unref?.();
	}

	private async poll(): Promise<void> {
		if (!this.host.isRunning()) return;
		if (this.pollInFlight) {
			this.schedulePoll(SUBAGENTS_POLL_INTERVAL_MS);
			return;
		}

		this.pollInFlight = true;
		const generation = this.refreshGeneration;
		try {
			await this.refreshFromFiles(generation);
		} finally {
			this.pollInFlight = false;
			if (this.shouldContinuePolling()) this.schedulePoll(SUBAGENTS_POLL_INTERVAL_MS);
		}
	}

	private async refreshFromFiles(generation = this.refreshGeneration): Promise<void> {
		const registry = await readSubagentRegistry(this.host.cwd);
		if (!this.isCurrentGeneration(generation)) return;

		const runDirs = await this.findActiveRegistryRunDirsForCurrentSession(registry, generation);
		if (!this.isCurrentGeneration(generation)) return;
		if (runDirs.length === 0) {
			this.currentRunDir = undefined;
			this.currentRunDirs = [];
			this.updateState(undefined);
			return;
		}

		const runs: SubagentRunRenderDetails[] = [];
		for (const runDir of runDirs) {
			const fileState = await readSubagentRunStateFromFiles(runDir, { includeLineCounts: false });
			if (!this.isCurrentGeneration(generation)) return;
			if (!fileState) {
				this.clearCachedRun(runDir);
				continue;
			}

			const activeAgents = activeSubagentStates(fileState.agents);
			if (activeAgents.length === 0) {
				if (allSubagentStatesTerminal(fileState.agents) || fileState.agents.length === 0) this.clearCachedRun(runDir);
				continue;
			}

			const tasks = this.taskPreviewsByRunDir.get(runDir);
			runs.push({
				runDir,
				agents: fileState.agents,
				...(tasks === undefined ? {} : { tasks }),
			});
		}

		if (runs.length === 0) {
			this.currentRunDir = undefined;
			this.currentRunDirs = [];
			this.updateState(undefined);
			return;
		}

		const orderedRuns = this.orderRuns(runs);
		this.currentRunDir = orderedRuns[0]?.runDir;
		this.currentRunDirs = orderedRuns.map((run) => run.runDir);
		this.updateState(this.buildStateFromRuns(orderedRuns, {
			live: true,
			snapshotOnly: false,
			checkedAt: Date.now(),
		}));
	}

	private async findActiveRegistryRunDirsForCurrentSession(registry: SubagentRegistry | undefined, generation: number): Promise<string[]> {
		if (!registry) return [];

		const sessionFile = this.host.sessionFile();
		if (!sessionFile) return [];

		const candidateRunDirs = this.registryRunDirsNewestFirst(registry);
		const matchingRunDirs: string[] = [];
		for (const runDir of candidateRunDirs) {
			if (!this.isCurrentGeneration(generation)) return [];
			if (!(await subagentRunHasParentSession(runDir, sessionFile))) continue;
			if (!this.isCurrentGeneration(generation)) return [];

			const state = await readSubagentRunStateFromFiles(runDir, { includeLineCounts: false });
			if (!this.isCurrentGeneration(generation)) return [];
			if (activeSubagentStates(state?.agents ?? []).length > 0) matchingRunDirs.push(runDir);
		}

		return matchingRunDirs;
	}

	private registryRunDirsNewestFirst(registry: SubagentRegistry): string[] {
		const runDirs: string[] = [];
		const seen = new Set<string>();
		const addRunDir = (runDir: string | undefined): void => {
			if (!runDir) return;
			const resolved = resolveSubagentRunDir(this.host.cwd, runDir);
			if (seen.has(resolved)) return;
			seen.add(resolved);
			runDirs.push(resolved);
		};

		addRunDir(registry.latestRunDir);
		Object.values(registry.runs)
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
			.forEach((run) => {
				this.rememberRunFreshness(run.runDir, this.parseRunTimestamp(run.updatedAt) ?? this.parseRunTimestamp(run.createdAt));
				addRunDir(run.runDir);
			});

		return runDirs;
	}

	private clearCachedRun(runDir: string): void {
		this.runFreshnessByRunDir.delete(runDir);
		this.snapshotByRunDir.delete(runDir);
		this.taskPreviewsByRunDir.delete(runDir);
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

	private isCurrentGeneration(generation: number): boolean {
		return generation === this.refreshGeneration;
	}

	private shouldContinuePolling(): boolean {
		const runs = this.state?.runs;
		if (runs?.length) return runs.some((run) => activeSubagentStates(run.agents).length > 0);
		return activeSubagentStates(this.state?.agents ?? []).length > 0;
	}

	private eventMatchesCurrentSession(eventSessionFile: string | undefined): boolean {
		if (!eventSessionFile) return true;
		const sessionFile = this.host.sessionFile();
		if (!sessionFile) return true;
		return resolve(eventSessionFile) === resolve(sessionFile);
	}
}
