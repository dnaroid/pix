import { resolve } from "node:path";
import { TODO_TOOL_NAME } from "./constants.js";
import { stringifyUnknown } from "./message-content.js";
import { hasOpenTodoTasks, isTodoDetails, isTodoLiveStateEvent } from "./todo-model.js";
import type { TodoDetails } from "./types.js";

export type TodoWidgetControllerHost = {
	sessionFile?(): string | undefined;
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

		this.updateDetailsForSession(data.sessionFile ?? this.host.sessionFile?.(), this.visibleDetails(data.details));
	}

	private visibleDetails(details: TodoDetails): TodoDetails | undefined {
		return hasOpenTodoTasks(details) ? details : undefined;
	}

	private updateDetailsForCurrentSession(next: TodoDetails | undefined, options: { preserveScoped?: boolean } = {}): void {
		this.updateDetailsForSession(this.host.sessionFile?.(), next, options);
	}

	private updateDetailsForSession(sessionFile: string | undefined, next: TodoDetails | undefined, options: { preserveScoped?: boolean } = {}): void {
		const previous = stringifyUnknown(this.currentSessionDetails());
		const key = this.sessionKey(sessionFile);
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
		const key = this.sessionKey(this.host.sessionFile?.());
		return key ? this.detailsBySessionFile.get(key) : this.unscopedDetails;
	}

	private sessionKey(sessionFile: string | undefined): string | undefined {
		return sessionFile ? resolve(sessionFile) : undefined;
	}
}
