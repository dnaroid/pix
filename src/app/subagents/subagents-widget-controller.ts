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
	private state: SubagentsWidgetState | undefined;
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

		if (activeSubagentStates(normalizedDetails.agents).length > 0) {
			this.state = {
				runDir,
				agents: normalizedDetails.agents,
				...(normalizedDetails.tasks === undefined ? {} : { tasks: normalizedDetails.tasks }),
				live: false,
				snapshotOnly: true,
				checkedAt: Date.now(),
			};
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
			this.snapshotByRunDir.set(run.runDir, {
				runDir: run.runDir,
				agents: run.agents,
				...(run.tasks === undefined ? {} : { tasks: run.tasks }),
				mode: "status",
			});
			if (run.tasks) this.taskPreviewsByRunDir.set(run.runDir, run.tasks);
		}

		const preferred = activeRuns.find((run) => run.runDir === this.currentRunDir) ?? activeRuns[0];
		if (!preferred) {
			this.currentRunDir = undefined;
			this.updateState(undefined);
			this.stopPolling();
			return;
		}

		this.currentRunDir = preferred.runDir;
		this.updateState({
			runDir: preferred.runDir,
			agents: preferred.agents,
			...(preferred.tasks === undefined ? {} : { tasks: preferred.tasks }),
			live: true,
			snapshotOnly: false,
			checkedAt: data.checkedAt,
		});
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
		let runDir = this.currentRunDir;
		if (!runDir) {
			const registry = await readSubagentRegistry(this.host.cwd);
			if (!this.isCurrentGeneration(generation)) return;

			runDir = await this.findActiveRegistryRunDirForCurrentSession(registry, generation);
			if (!this.isCurrentGeneration(generation)) return;
			if (runDir) this.currentRunDir = runDir;
		}

		if (!runDir) {
			if (!this.isCurrentGeneration(generation)) return;
			this.updateState(undefined);
			return;
		}

		this.currentRunDir = runDir;
		const fileState = await readSubagentRunStateFromFiles(runDir, { includeLineCounts: false });
		if (!this.isCurrentGeneration(generation)) return;
		if (!fileState) {
			await this.clearMissingRunAndMaybeSelectReplacement(runDir, generation);
			return;
		}

		const activeAgents = activeSubagentStates(fileState.agents);
		if (activeAgents.length === 0) {
			if (allSubagentStatesTerminal(fileState.agents) || fileState.agents.length === 0) {
				this.clearCachedRun(runDir);
				this.currentRunDir = undefined;
				this.updateState(undefined);
			}
			return;
		}

		const tasks = this.taskPreviewsByRunDir.get(runDir);
		this.updateState({
			runDir,
			agents: fileState.agents,
			...(tasks === undefined ? {} : { tasks }),
			live: true,
			snapshotOnly: false,
			checkedAt: Date.now(),
		});
	}

	private async findActiveRegistryRunDirForCurrentSession(registry: SubagentRegistry | undefined, generation: number): Promise<string | undefined> {
		if (!registry) return undefined;

		const sessionFile = this.host.sessionFile();
		if (!sessionFile) return undefined;

		const candidateRunDirs = this.registryRunDirsNewestFirst(registry);
		for (const runDir of candidateRunDirs) {
			if (!this.isCurrentGeneration(generation)) return undefined;
			if (!(await subagentRunHasParentSession(runDir, sessionFile))) continue;
			if (!this.isCurrentGeneration(generation)) return undefined;

			const state = await readSubagentRunStateFromFiles(runDir, { includeLineCounts: false });
			if (!this.isCurrentGeneration(generation)) return undefined;
			if (activeSubagentStates(state?.agents ?? []).length > 0) return runDir;
		}

		return undefined;
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
			.forEach((run) => addRunDir(run.runDir));

		return runDirs;
	}

	private async clearMissingRunAndMaybeSelectReplacement(runDir: string, generation: number): Promise<void> {
		this.clearCachedRun(runDir);
		if (this.currentRunDir === runDir) this.currentRunDir = undefined;

		const registry = await readSubagentRegistry(this.host.cwd);
		if (!this.isCurrentGeneration(generation)) return;
		const replacementRunDir = await this.findActiveRegistryRunDirForCurrentSession(registry, generation);
		if (!this.isCurrentGeneration(generation)) return;

		if (replacementRunDir) {
			this.currentRunDir = replacementRunDir;
			await this.refreshFromFiles(generation);
			return;
		}

		this.updateState(undefined);
	}

	private clearCachedRun(runDir: string): void {
		this.snapshotByRunDir.delete(runDir);
		this.taskPreviewsByRunDir.delete(runDir);
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
		return activeSubagentStates(this.state?.agents ?? []).length > 0;
	}

	private eventMatchesCurrentSession(eventSessionFile: string | undefined): boolean {
		if (!eventSessionFile) return true;
		const sessionFile = this.host.sessionFile();
		if (!sessionFile) return true;
		return resolve(eventSessionFile) === resolve(sessionFile);
	}
}
