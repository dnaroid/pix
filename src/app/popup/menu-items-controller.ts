import { resolve } from "node:path";
import type { AgentSessionRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzySearch, type FuzzySearchItem } from "../../fuzzy.js";
import type { PopupMenuItem } from "../../ui.js";
import { PI_FAVORITE_MODEL_REFS, THINKING_LEVELS } from "../constants.js";
import { APP_ICONS } from "../icons.js";
import { parseScopedModelRef } from "../model/model-ref.js";
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
	ScopedSessionModel,
	SessionModel,
	SlashCommand,
	ThinkingLevel,
	ThinkingMenuValue,
	UserMessageJumpMenuValue,
	UserMessageMenuValue,
} from "../types.js";

export type AppMenuItemsControllerHost = {
	runtime(): AgentSessionRuntime | undefined;
	getBuiltinSlashCommands(): readonly SlashCommand[];
	getEntries(): readonly Entry[];
	getResumeSessions(): readonly SessionInfo[];
};

export class AppMenuItemsController {
	private resumeMenuLoaderCache: {
		sessions: readonly SessionInfo[];
		currentSessionFile: string | undefined;
		query: string;
		loader: SessionInfoMenuItemsLoader;
	} | undefined;
	private userMessageJumpItems: PopupMenuItem<UserMessageJumpMenuValue>[] | undefined;

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
		}));
	}

	modelRef(model: SessionModel): string {
		return `${model.provider}/${model.id}`;
	}

	getFavoriteScopedModels(): ScopedSessionModel[] {
		const configuredRefs = this.host.runtime()?.services.settingsManager.getEnabledModels();
		const refs = configuredRefs && configuredRefs.length > 0 ? configuredRefs : PI_FAVORITE_MODEL_REFS;
		return this.resolveScopedModelRefs(refs);
	}

	getModelMenuItems(query: string): PopupMenuItem<ModelMenuValue>[] {
		const models = [...this.getModelMenuModels()].sort((left, right) => {
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
			return {
				value: { model, ref, current },
				label: ref,
				aliases: [model.id, model.name, model.provider],
				keywords: [model.name, `${model.provider} ${model.id}`],
			};
		});

		return fuzzySearch(items, query).map((match) => ({
			value: match.value,
			label: `${match.value.ref}${match.value.current ? ` ${APP_ICONS.check}` : ""}`,
			description: match.value.model.name,
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

	async refreshUserMessageJumpMenuItems(): Promise<void> {
		const runtime = this.host.runtime();
		if (!runtime) {
			this.userMessageJumpItems = undefined;
			return;
		}

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
	}

	getQueueMessageMenuItems(): PopupMenuItem<QueueMessageMenuValue>[] {
		return [
			{ value: "cancel", label: "Cancel send", description: "Remove this message from the queue" },
			{ value: "edit", label: "Edit", description: "Move it back to the editor" },
			{ value: "send-now", label: "Send immediately", description: "Send now and keep the rest queued" },
		];
	}

	getResumeMenuItems(query: string, limit?: number): PopupMenuItem<ResumeMenuValue>[] {
		const sessionFile = this.host.runtime()?.session.sessionFile;
		const currentSessionFile = sessionFile ? resolve(sessionFile) : undefined;
		const loader = this.getResumeMenuItemsLoader(currentSessionFile, query);
		return [
			{ value: { kind: "new" }, label: "new", description: "Create a new session" },
			...loader.items(limit).map((item) => ({
				...item,
				value: { kind: "session", session: item.value } satisfies ResumeMenuValue,
			})),
		];
	}

	private getResumeMenuItemsLoader(currentSessionFile: string | undefined, query: string): SessionInfoMenuItemsLoader {
		const sessions = this.host.getResumeSessions();
		const cache = this.resumeMenuLoaderCache;
		if (
			cache &&
			cache.sessions === sessions &&
			cache.currentSessionFile === currentSessionFile &&
			cache.query === query
		) {
			return cache.loader;
		}

		const loader = createSessionInfoMenuItemsLoader(sessions, currentSessionFile, query);
		this.resumeMenuLoaderCache = { sessions, currentSessionFile, query, loader };
		return loader;
	}

	private getAllSlashCommands(): readonly SlashCommand[] {
		return [...this.host.getBuiltinSlashCommands(), ...this.getResourceSlashCommands()];
	}

	private isCurrentModel(model: SessionModel): boolean {
		const current = this.host.runtime()?.session.model;
		return current?.provider === model.provider && current.id === model.id;
	}

	private resolveScopedModelRefs(modelRefs: readonly string[]): ScopedSessionModel[] {
		const registry = this.host.runtime()?.services.modelRegistry;
		if (!registry) return [];

		registry.refresh();
		const scopedModels: ScopedSessionModel[] = [];
		for (const modelRef of modelRefs) {
			const parsed = parseScopedModelRef(modelRef);
			if (!parsed) continue;

			const model = registry.find(parsed.provider, parsed.modelId) as SessionModel | undefined;
			if (!model) continue;
			scopedModels.push({
				model,
				...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
			});
		}
		return scopedModels;
	}

	private getModelMenuModels(): SessionModel[] {
		const session = this.host.runtime()?.session;
		const scopedModels = session?.scopedModels.length ? session.scopedModels : this.getFavoriteScopedModels();
		if (!scopedModels.length) return [];

		const registry = this.host.runtime()?.services.modelRegistry;
		registry?.refresh();
		return scopedModels.map((scoped) => {
			const refreshed = registry?.find(scoped.model.provider, scoped.model.id);
			return (refreshed ?? scoped.model) as SessionModel;
		});
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
		}
	}
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
