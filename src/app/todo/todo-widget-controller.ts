import { resolve } from "node:path";
import { TODO_TOOL_NAME } from "../constants.js";
import { stringifyUnknown } from "../rendering/message-content.js";
import { hasOpenTodoTasks, isTodoDetails, isTodoLiveStateEvent } from "./todo-model.js";
import type { TodoDetails } from "../types.js";

export type TodoWidgetControllerHost = {
	sessionFile?(): string | undefined;
	sessionId?(): string | undefined;
	isRunning(): boolean;
	render(): void;
};

export class AppTodoWidgetController {
	private unscopedDetails: TodoDetails | undefined;
	private readonly detailsBySessionFile = new Map<string, TodoDetails>();

	constructor(private readonly host: TodoWidgetControllerHost) {}

	get widgetDetails(): TodoDetails | undefined {
		return this.currentSessionDetails();
	}

	reset(): void {
		this.updateDetailsForCurrentSession(undefined, { preserveScoped: true });
	}

	observeToolResult(toolName: string, details: unknown, isError = false): void {
		if (toolName !== TODO_TOOL_NAME) return;
		if (isError || !isTodoDetails(details) || details.error) return;

		this.updateDetailsForCurrentSession(this.visibleDetails(details));
	}

	observeLiveState(data: unknown): void {
		if (!isTodoLiveStateEvent(data)) return;

		const sessionFile = data.sessionFile;
		const sessionId = data.sessionId;
		if (!sessionFile && !sessionId && this.currentSessionKey()) return;

		this.updateDetailsForSession(sessionFile, sessionId, this.visibleDetails(data.details));
	}

	private visibleDetails(details: TodoDetails): TodoDetails | undefined {
		return hasOpenTodoTasks(details) ? details : undefined;
	}

	private updateDetailsForCurrentSession(next: TodoDetails | undefined, options: { preserveScoped?: boolean } = {}): void {
		this.updateDetailsForSession(this.host.sessionFile?.(), this.host.sessionId?.(), next, options);
	}

	private updateDetailsForSession(sessionFile: string | undefined, sessionId: string | undefined, next: TodoDetails | undefined, options: { preserveScoped?: boolean } = {}): void {
		const previous = stringifyUnknown(this.currentSessionDetails());
		const key = this.sessionKey(sessionFile, sessionId);
		if (key) {
			if (next) this.detailsBySessionFile.set(key, next);
			else if (options.preserveScoped !== true) this.detailsBySessionFile.delete(key);
		} else {
			this.unscopedDetails = next;
		}

		const visibleNext = stringifyUnknown(this.currentSessionDetails());
		if (previous !== visibleNext && this.host.isRunning()) this.host.render();
	}

	private currentSessionDetails(): TodoDetails | undefined {
		const key = this.currentSessionKey();
		return key ? this.detailsBySessionFile.get(key) : this.unscopedDetails;
	}

	private currentSessionKey(): string | undefined {
		return this.sessionKey(this.host.sessionFile?.(), this.host.sessionId?.());
	}

	private sessionKey(sessionFile: string | undefined, sessionId: string | undefined): string | undefined {
		if (sessionFile) return `file:${resolve(sessionFile)}`;
		const normalizedSessionId = sessionId?.trim();
		return normalizedSessionId ? `id:${normalizedSessionId}` : undefined;
	}
}
