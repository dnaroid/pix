import { resolve } from "node:path";
import type { AgentSessionRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzySearch, type FuzzySearchItem } from "../../fuzzy.js";
import type { PopupMenuItem } from "../../ui.js";
import { THINKING_LEVELS } from "../constants.js";
import { APP_ICONS } from "../icons.js";
import { buildUserMessageJumpItems, createSessionInfoMenuItemsLoader, filterUserMessageJumpItems, type SessionInfoMenuItemsLoader } from "./popup-menu-controller.js";
import { getResourceSlashCommands, getSlashCommandMatches, parseSlashInput } from "../commands/slash-commands.js";
import { isRecord } from "../guards.js";
import { renderUserMessageContent } from "../rendering/message-content.js";
import { sessionHistoryFullBranchEntries } from "../session/pix-system-message.js";
import type {
	Entry,
	ModelMenuValue,
	QueueMessageMenuValue,
	ResumeMenuValue,
	SessionModel,
	SlashCommand,
	ThinkingLevel,
	ThinkingMenuValue,
	UserMessageJumpMenuValue,
	UserMessageMenuValue,
} from "../types.js";

export type AppMenuItemsControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	visibleModels(): readonly string[] | undefined;
	getBuiltinSlashCommands(): readonly SlashCommand[];
	getEntries(): readonly Entry[];
	getResumeSessions(): readonly SessionInfo[];
	getOpenSessionPaths?(): readonly string[];
};

export class AppMenuItemsController {
	private resumeMenuLoaderCache: {
		sessions: readonly SessionInfo[];
		currentSessionFile: string | undefined;
		query: string;
		excludedSessionPathsKey: string;
		loader: SessionInfoMenuItemsLoader;
	} | undefined;
	private userMessageJumpItems: PopupMenuItem<UserMessageJumpMenuValue>[] | undefined;
	private userMessageJumpLoading = false;

	constructor(private readonly host: AppMenuItemsControllerHost) {}

	parseSlashInput(text: string) {
		return parseSlashInput(text);
	}

	getResourceSlashCommands(): SlashCommand[] {
		return getResourceSlashCommands(this.host.runtime(), this.host.getBuiltinSlashCommands());
	}

	getSlashCommandMatches(query: string, limit?: number) {
		return getSlashCommandMatches(this.getAllSlashCommands(), query, limit);
	}

	getSlashCommandMenuItems(query: string): PopupMenuItem<SlashCommand>[] {
		return this.getSlashCommandMatches(query).map((match) => ({
			value: match.value,
			label: `/${match.value.name}`,
			description: match.value.description,
			labelHighlightRanges: match.matchedText === match.label
				? match.matchedRanges.map((range) => ({ start: range.start + 1, end: range.end + 1 }))
				: [],
		}));
	}

	modelRef(model: SessionModel): string {
		return `${model.provider}/${model.id}`;
	}

	getModelMenuItems(query: string, includeHidden = false): PopupMenuItem<ModelMenuValue>[] {
		const visibleModels = this.host.visibleModels();
		const models = [...this.getModelMenuModels()]
			.filter((model) => includeHidden || this.isVisibleModel(model, visibleModels))
			.sort((left, right) => {
			const leftCurrent = this.isCurrentModel(left);
			const rightCurrent = this.isCurrentModel(right);
			if (leftCurrent && !rightCurrent) return -1;
			if (!leftCurrent && rightCurrent) return 1;

			const providerDelta = left.provider.localeCompare(right.provider);
			return providerDelta === 0 ? left.id.localeCompare(right.id) : providerDelta;
		});

		const items: FuzzySearchItem<ModelMenuValue>[] = models.map((model) => {
			const ref = this.modelRef(model);
			const current = this.isCurrentModel(model);
			const visible = current || visibleModels === undefined || visibleModels.includes(ref);
			return {
				value: { model, ref, current, visible },
				label: ref,
				aliases: [model.id, model.name, model.provider],
				keywords: [model.name, `${model.provider} ${model.id}`],
			};
		});

		return fuzzySearch(items, query).map((match) => ({
			value: match.value,
			label: `${match.value.ref}${match.value.current ? ` ${APP_ICONS.check}` : ""}`,
			description: match.value.model.name,
			labelHighlightRanges: labelHighlightRangesFromMatch(match.matchedText, match.matchedRanges, match.label),
		}));
	}

	getThinkingMenuItems(query: string): PopupMenuItem<ThinkingMenuValue>[] {
		const session = this.host.runtime()?.session;
		const currentLevel = session?.thinkingLevel ?? "off";
		const levels = session ? normalizeAvailableThinkingLevels(session.getAvailableThinkingLevels()) : [...THINKING_LEVELS];
		const items: FuzzySearchItem<ThinkingMenuValue>[] = levels.map((level) => ({
			value: { level, current: level === currentLevel },
			label: level,
			keywords: [
				level === "off" ? "disabled none no reasoning" : "reasoning thinking effort",
				level === "minimal" ? "fast small" : "",
				level === "xhigh" ? "extra highest maximum" : "",
				level === "max" ? "maximum most" : "",
			].filter(Boolean),
		}));

		return fuzzySearch(items, query).map((match) => ({
			value: match.value,
			label: `${match.value.level}${match.value.current ? ` ${APP_ICONS.check}` : ""}`,
			description: this.thinkingLevelDescription(match.value.level, levels),
		}));
	}

	getUserMessageMenuItems(): PopupMenuItem<UserMessageMenuValue>[] {
		return [
			{ value: "copy", label: "Copy message", description: "Copy the full user message" },
			{ value: "fork", label: "Fork", description: "Create a new session before this message" },
			{ value: "fork-new-tab", label: "Fork in new tab", description: "Create a fork in a new tab" },
			{ value: "undo", label: "Undo changes", description: "Revert recorded commands and cut session here" },
		];
	}

	getUserMessageJumpMenuItems(query: string): PopupMenuItem<UserMessageJumpMenuValue>[] {
		return filterUserMessageJumpItems(this.userMessageJumpItems ?? buildUserMessageJumpItems(this.host.getEntries()), query);
	}

	isUserMessageJumpLoading(): boolean {
		return this.userMessageJumpLoading;
	}

	async refreshUserMessageJumpMenuItems(): Promise<void> {
		const runtime = this.host.runtime();
		if (!runtime) {
			this.userMessageJumpItems = undefined;
			this.userMessageJumpLoading = false;
			return;
		}

		this.userMessageJumpLoading = true;
		try {
			const entries = await sessionHistoryFullBranchEntries(runtime.session);
			const loadedBySessionEntryId = new Map(
				this.host.getEntries()
					.filter((entry): entry is Extract<Entry, { kind: "user" }> => entry.kind === "user" && typeof entry.sessionEntryId === "string")
					.map((entry) => [entry.sessionEntryId, entry]),
			);
			const sources = entries.flatMap((entry) => {
				if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") return [];
				const text = renderUserMessageContent(entry.message.content);
				if (!text) return [];
				const loaded = loadedBySessionEntryId.get(entry.id);
				return [{ text, ...(loaded ? { entryId: loaded.id } : {}), sessionEntryId: entry.id }];
			});
			this.userMessageJumpItems = buildUserMessageJumpItems(sources);
		} finally {
			this.userMessageJumpLoading = false;
		}
	}

	getQueueMessageMenuItems(): PopupMenuItem<QueueMessageMenuValue>[] {
		return [
			{ value: "cancel", label: "Cancel send", description: "Remove this message from the queue" },
			{ value: "edit", label: "Edit", description: "Move it back to the editor" },
			{ value: "send-now", label: "Send immediately", description: "Send now and keep the rest queued" },
		];
	}

	getResumeMenuItems(query: string, limit?: number, options: { draft?: boolean } = {}): PopupMenuItem<ResumeMenuValue>[] {
		const sessionFile = this.host.runtime()?.session.sessionFile;
		const currentSessionFile = options.draft ? undefined : sessionFile ? resolve(sessionFile) : undefined;
		const excludedSessionPaths = options.draft
			? this.host.getOpenSessionPaths?.().map((path) => resolve(path)) ?? []
			: [];
		const excluded = new Set(excludedSessionPaths);
		const sessions = excluded.size === 0
			? this.host.getResumeSessions()
			: this.host.getResumeSessions().filter((session) => !excluded.has(resolve(session.path)));
		const loader = this.getResumeMenuItemsLoader(sessions, currentSessionFile, query, [...excluded].sort().join("\0"));
		return [
			...(options.draft
				? [{ value: { kind: "new" } as const, label: "New session", description: "Start typing in the composer" }]
				: [{ value: { kind: "new" } as const, label: "new", description: "Create a new session" }]),
			...loader.items(limit).map((item) => ({
				...item,
				value: { kind: "session", session: item.value } satisfies ResumeMenuValue,
			})),
		];
	}

	private getResumeMenuItemsLoader(
		sessions: readonly SessionInfo[],
		currentSessionFile: string | undefined,
		query: string,
		excludedSessionPathsKey: string,
	): SessionInfoMenuItemsLoader {
		const cache = this.resumeMenuLoaderCache;
		if (
			cache &&
			cache.sessions === sessions &&
			cache.currentSessionFile === currentSessionFile &&
			cache.query === query &&
			cache.excludedSessionPathsKey === excludedSessionPathsKey
		) {
			return cache.loader;
		}

		const loader = createSessionInfoMenuItemsLoader(sessions, currentSessionFile, query);
		this.resumeMenuLoaderCache = { sessions, currentSessionFile, query, excludedSessionPathsKey, loader };
		return loader;
	}

	private getAllSlashCommands(): readonly SlashCommand[] {
		return [...this.host.getBuiltinSlashCommands(), ...this.getResourceSlashCommands()];
	}

	private isCurrentModel(model: SessionModel): boolean {
		const current = this.host.runtime()?.session.model;
		return current?.provider === model.provider && current.id === model.id;
	}

	private isVisibleModel(model: SessionModel, visibleModels: readonly string[] | undefined): boolean {
		return this.isCurrentModel(model) || visibleModels === undefined || visibleModels.includes(this.modelRef(model));
	}

	private getModelMenuModels(): SessionModel[] {
		const runtime = this.host.runtime();
		if (!runtime) return [];

		const modelRuntime = runtime.services.modelRuntime;
		const models = [...modelRuntime.getAvailableSnapshot()] as SessionModel[];
		const current = runtime.session.model as SessionModel | undefined;
		if (current && !models.some((model) => model.provider === current.provider && model.id === current.id)) {
			models.push(current);
		}
		return models;
	}

	private thinkingLevelDescription(level: ThinkingLevel, _availableLevels: readonly ThinkingLevel[]): string {
		switch (level) {
			case "off":
				return "No reasoning/thinking";
			case "minimal":
				return "Minimal reasoning";
			case "low":
				return "Low reasoning";
			case "medium":
				return "Medium reasoning";
			case "high":
				return "High reasoning";
			case "xhigh":
				return "Extra high reasoning";
			case "max":
				return "Maximum reasoning";
		}
	}
}

function labelHighlightRangesFromMatch(matchedText: string, matchedRanges: readonly { start: number; end: number }[], label: string): readonly { start: number; end: number }[] {
	if (matchedText === label) return matchedRanges;
	const offset = label.toLocaleLowerCase().indexOf(matchedText.toLocaleLowerCase());
	if (offset < 0) return [];
	return matchedRanges.map((range) => ({ start: offset + range.start, end: offset + range.end }));
}

function normalizeAvailableThinkingLevels(levels: readonly string[] | undefined): ThinkingLevel[] {
	const seen = new Set<ThinkingLevel>();
	const normalized: ThinkingLevel[] = [];
	for (const level of levels ?? THINKING_LEVELS) {
		if (!isAvailableThinkingLevel(level) || seen.has(level)) continue;
		seen.add(level);
		normalized.push(level);
	}
	return normalized.length > 0 ? normalized : ["off"];
}

function isAvailableThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}
