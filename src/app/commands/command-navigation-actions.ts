import { resolve } from "node:path";
import type { AgentSessionRuntime, SessionInfo } from "@earendil-works/pi-coding-agent";
import type { CommandControllerHost } from "./command-host.js";
import { getIdleRuntime, getRuntime } from "./command-runtime.js";
import { createId } from "../id.js";
import { isRecord } from "../guards.js";
import { renderContent } from "../rendering/message-content.js";
import { sanitizeText } from "../rendering/render-text.js";
import { createSessionSearchMenuItems, searchSessions } from "../session/session-search.js";
import { loadResumeSessionsInChunks, type ResumeSessionLoaderOptions } from "../session/resume-session-loader.js";
import type { PopupMenuPlacement, SessionTreeNode } from "../types.js";

function nextTick(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

export class NavigationCommandActions {
	private resumeLoadId = 0;

	constructor(
		private readonly host: CommandControllerHost,
		private readonly resumeSessionLoader: (options: ResumeSessionLoaderOptions) => Promise<readonly SessionInfo[]> = loadResumeSessionsInChunks,
	) {}

	async runForkCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "fork");
		if (!runtime) return;

		let entryId = argumentsText.trim();
		if (!entryId) {
			const userMessages = runtime.session.getUserMessagesForForking();
			entryId = userMessages[userMessages.length - 1]?.entryId ?? "";
		}
		if (!entryId) throw new Error("No user messages to fork from");

		this.host.setStatus("forking session");
		this.host.render();
		const result = await runtime.fork(entryId);
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Fork cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.loadSessionHistory();
		if (result.selectedText) this.host.setInput(result.selectedText);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Forked from entry ${entryId}.` });
		this.host.setSessionStatus(runtime.session);
	}

	async runCloneCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "clone");
		if (!runtime) return;

		const leafId = runtime.session.sessionManager.getLeafId();
		if (!leafId) {
			this.host.toast.warning("Nothing to clone yet");
			return;
		}

		this.host.setStatus("cloning session");
		this.host.render();
		const result = await runtime.fork(leafId, { position: "at" });
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Clone cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.afterSessionReplacement("Cloned to a new session.");
	}

	async runTreeCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "tree");
		if (!runtime) return;

		const targetId = argumentsText.trim();
		if (!targetId) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: this.formatSessionTree(runtime) });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.setStatus("navigating tree");
		this.host.render();
		const result = await runtime.session.navigateTree(targetId);
		if (result.aborted) {
			this.host.toast.info("Tree navigation cancelled");
			this.host.setSessionStatus(runtime.session);
			return;
		}
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Tree navigation cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.loadSessionHistory();
		if (result.editorText && !this.host.getInput().trim()) this.host.setInput(result.editorText);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Navigated to entry ${targetId}.` });
		this.host.setSessionStatus(runtime.session);
	}

	async runJumpCommand(argumentsText: string): Promise<void> {
		const runtime = getRuntime(this.host, "jump");
		if (!runtime) return;

		this.host.openDirectPopupMenu("user-message-jump", { preserveStatus: true });
		this.host.setDirectPopupMenuQuery(argumentsText.trim());
		this.host.render();
		try {
			await this.host.refreshUserMessageJumpMenuItems();
		} catch (error) {
			this.host.toast.error(`Could not load jump messages: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.host.render();
		}
	}

	async runSearchCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "search");
		if (!runtime) return;

		const query = argumentsText.trim();
		if (!query) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Usage: /search <text>" });
			this.host.toast.info("Enter text to search sessions");
			this.host.setSessionStatus(runtime.session);
			return;
		}

		let lastProgressText = "";
		this.host.setStatus("searching sessions…");
		this.host.render();

		try {
			const results = await searchSessions(query, {
				cwd: this.host.options.cwd,
				onProgress: (loaded, total) => {
					const progressText = total > 0 ? `searching sessions… ${loaded}/${total}` : "searching sessions…";
					if (progressText === lastProgressText) return;
					lastProgressText = progressText;
					this.host.setStatus(progressText);
					this.host.render();
				},
			});

			if (results.length === 0) {
				this.host.addEntry({ id: createId("system"), kind: "system", text: `No sessions found for: ${query}` });
				this.host.toast.info("No matching sessions");
				this.host.setSessionStatus(runtime.session);
				this.host.render();
				return;
			}

			const selected = await this.host.showMenu(createSessionSearchMenuItems(results), {
				title: `Search sessions: ${query}`,
				placeholder: "Filter results",
				emptyText: "No matching search results",
				searchable: true,
			});
			if (!selected) {
				this.host.setSessionStatus(runtime.session);
				return;
			}

			await this.host.openSearchResultInNewTab(selected);
		} catch (error) {
			this.host.addEntry({ id: createId("error"), kind: "error", text: `Session search failed: ${error instanceof Error ? error.message : String(error)}` });
			this.host.toast.error("Session search failed");
			this.host.setSessionStatus(runtime.session);
			this.host.render();
		}
	}

	async runUnsupportedBuiltinCommand(commandName: string, message: string): Promise<void> {
		this.host.addEntry({ id: createId("system"), kind: "system", text: message });
		this.host.toast.warning(`/${commandName} is not available in pix`);
		this.host.setSessionStatus(this.host.runtime()?.session);
	}

	async runResumePathCommand(sessionPath: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "resume");
		if (!runtime) return;

		const resolvedSessionPath = resolve(runtime.cwd, sessionPath);
		this.host.setStatus("switching session");
		this.host.render();
		const result = await runtime.switchSession(resolvedSessionPath);
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Resume cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.loadSessionHistory();
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Resumed session ${resolvedSessionPath}` });
		this.host.setSessionStatus(runtime.session);
	}

	async runResumeCommand(queryOrOptions: string | { preserveStatus?: boolean; placement?: PopupMenuPlacement } = ""): Promise<void> {
		const preserveStatus = typeof queryOrOptions === "object" && queryOrOptions.preserveStatus === true;
		const placement = typeof queryOrOptions === "object" ? queryOrOptions.placement : undefined;
		const initialQuery = typeof queryOrOptions === "string" ? queryOrOptions : "";
		const runtime = preserveStatus ? this.host.runtime() : getIdleRuntime(this.host, "resume");
		if (!runtime) {
			if (!preserveStatus) this.host.render();
			return;
		}

		if (runtime.session.isStreaming) {
			if (!preserveStatus) {
				this.host.toast.warning("/resume is unavailable while the agent is running");
				this.host.render();
			}
			return;
		}

		if (this.host.getResumeLoading()) {
			if (!preserveStatus) this.host.setStatus("loading sessions…");
			this.host.render();
			return;
		}

		this.host.setResumeLoading(true);
		if (!preserveStatus) this.host.setStatus("loading sessions…");
		this.host.openDirectPopupMenu("resume", { preserveStatus, ...(placement === undefined ? {} : { placement }) });
		this.host.setDirectPopupMenuQuery(initialQuery);
		if (this.host.getResumeSessions().length > 0) {
			this.host.openResumeMenuWithQuery(initialQuery);
		}
		this.host.render();

		const loadId = ++this.resumeLoadId;
		void this.loadResumeSessionsInBackground({ loadId, preserveStatus, session: runtime.session });
	}

	private async loadResumeSessionsInBackground(options: { loadId: number; preserveStatus: boolean; session: AgentSessionRuntime["session"] }): Promise<void> {
		try {
			await nextTick();
			await this.resumeSessionLoader({
				cwd: this.host.options.cwd,
				onChunk: (sessions, progress) => {
					if (options.loadId !== this.resumeLoadId) return;
					this.host.setResumeSessions([...sessions]);
					if (progress.done) {
						this.host.setResumeLoading(false);
						if (!options.preserveStatus) this.host.setSessionStatus(options.session);
					}
					this.host.render();
				},
			});
		} catch (error) {
			if (options.loadId !== this.resumeLoadId) return;
			this.host.setResumeLoading(false);
			this.host.setDirectPopupMenu(undefined);
			this.host.setDirectPopupMenuPreserveStatus(false);
			this.host.setDirectPopupMenuQuery("");
			this.host.closeResumeMenu();
			this.host.addEntry({ id: createId("error"), kind: "error", text: `Session list failed: ${error instanceof Error ? error.message : String(error)}` });
			if (!options.preserveStatus) this.host.toast.error("Failed to load sessions");
			if (!options.preserveStatus) this.host.setSessionStatus(options.session);
			this.host.render();
		}
	}

	private formatSessionTree(runtime: AgentSessionRuntime): string {
		const tree = runtime.session.sessionManager.getTree();
		const leafId = runtime.session.sessionManager.getLeafId();
		if (tree.length === 0) return "Session tree is empty.";

		const lines = ["Session tree", "Use /tree <entry-id> to navigate."];
		const walk = (node: SessionTreeNode, depth: number): void => {
			const marker = node.entry.id === leafId ? "*" : " ";
			const label = node.label ? ` [${node.label}]` : "";
			lines.push(`${"  ".repeat(depth)}${marker} ${node.entry.id.slice(0, 8)} ${this.describeSessionTreeEntry(node.entry)}${label}`);
			for (const child of node.children) walk(child, depth + 1);
		};

		for (const node of tree) walk(node, 0);
		return lines.join("\n");
	}

	private describeSessionTreeEntry(entry: unknown): string {
		if (!isRecord(entry)) return "entry";
		const type = typeof entry.type === "string" ? entry.type : "entry";
		if (type === "message" && isRecord(entry.message)) {
			const role = typeof entry.message.role === "string" ? entry.message.role : "message";
			const content = entry.message.content;
			let text = "";
			if (typeof content === "string") text = content;
			else if (Array.isArray(content)) text = renderContent(content);
			return `${role}: ${sanitizeText(text).slice(0, 80)}`;
		}
		if (type === "model_change") return `model: ${String(entry.provider ?? "")}/${String(entry.modelId ?? "")}`;
		if (type === "thinking_level_change") return `thinking: ${String(entry.thinkingLevel ?? "")}`;
		if (type === "compaction") return "compaction";
		if (type === "branch_summary") return "branch summary";
		return type.replaceAll("_", " ");
	}
}
