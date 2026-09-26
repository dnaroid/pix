import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { Value } from "typebox/value";
import { ProjectTasksSchema, type ProjectTasksSchemaType } from "../../schemas/tasks-schema.js";
import type { WorkspaceToolSurface, WorkspaceToolSurfaceLine, WorkspaceToolSurfaceSnapshot } from "./workspace-tool-controller.js";

type ProjectTask = ProjectTasksSchemaType["tasks"][number];
type ProjectTaskType = ProjectTask["type"];
type ProjectTaskStatus = ProjectTask["status"];

const TASK_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/tasks.json";
const TASK_TYPES: readonly ProjectTaskType[] = ["bug", "feature", "improvement"];
const TASK_STATUSES: readonly ProjectTaskStatus[] = ["backlog", "todo", "in-progress", "done"];
const MAX_TASK_DOCUMENT_BYTES = 1024 * 1024;

type EditField = "title" | "description" | "type" | "status" | "save";
type EditState = {
	taskId?: string;
	field: EditField;
	title: string;
	description: string;
	type: ProjectTaskType;
	status: ProjectTaskStatus;
};

export type TasksSurfaceHost = {
	cwd: string;
	render(): void;
	runTask(task: ProjectTask): void | Promise<void>;
};

export class TasksWorkspaceToolSurface implements WorkspaceToolSurface {
	readonly id = "tasks" as const;
	private document: ProjectTasksSchemaType = { $schema: TASK_SCHEMA_URL, version: 1, tasks: [] };
	private loading = false;
	private saving = false;
	private error: string | undefined;
	private selectedTaskId: string | undefined;
	private edit: EditState | undefined;
	private pendingDeleteId: string | undefined;
	private generation = 0;

	constructor(private readonly host: TasksSurfaceHost) {}

	async open(): Promise<void> {
		await this.load();
	}

	close(): void {
		this.generation += 1;
		this.edit = undefined;
		this.pendingDeleteId = undefined;
	}

	canClose(): boolean {
		return !this.loading && !this.saving;
	}

	snapshot(): WorkspaceToolSurfaceSnapshot {
		if (this.edit) return this.editSnapshot();
		const lines: WorkspaceToolSurfaceLine[] = [];
		if (this.loading && this.document.tasks.length === 0) {
			lines.push({ text: "Reading .pi/tasks.jsonc…", variant: "muted" });
		} else if (this.error) {
			lines.push({ text: this.error, variant: "error" });
			lines.push({ text: "Retry", action: "refresh", control: "button" });
		} else if (this.document.tasks.length === 0) {
			lines.push({ text: "No project tasks yet.", variant: "muted" });
			lines.push({ text: "Add task", action: "add", control: "button" });
			lines.push({ text: "Refresh", action: "refresh", control: "button" });
		} else {
			lines.push({ text: "Add task", action: "add", control: "button" });
			lines.push({ text: "Refresh", action: "refresh", control: "button" });
			lines.push({ text: "" });
			for (const type of TASK_TYPES) {
				const tasks = this.document.tasks.filter((task) => task.type === type);
				lines.push({ text: `${typeLabel(type)}  ${tasks.length}`, variant: "muted" });
				for (const task of tasks) {
					const selected = task.id === this.selectedTaskId;
					const marker = selected ? "›" : " ";
					const session = task.sessionId ? " · session" : "";
					lines.push({
						text: `${marker} ${statusIcon(task.status)} ${taskLabel(task)} · ${statusLabel(task.status)}${session}`,
						variant: selected ? "accent" : "normal",
						action: `task:${task.id}`,
					});
				}
			}
			const selected = this.selectedTask();
			if (selected) {
				lines.push({ text: "" });
				lines.push({ text: `Selected · ${taskLabel(selected)}`, variant: "accent" });
				lines.push({ text: "Run task", action: "run-selected", control: "button" });
				lines.push({ text: "Edit task", action: "edit-selected", control: "button" });
				lines.push({ text: `Next status · ${statusLabel(selected.status)}`, action: "status-next", control: "button" });
				lines.push({ text: `Next type · ${typeLabel(selected.type)}`, action: "type-next", control: "button" });
				lines.push({ text: "Move up", action: "move-up", control: "button" });
				lines.push({ text: "Move down", action: "move-down", control: "button" });
				if (this.pendingDeleteId === selected.id) {
					lines.push({ text: "Confirm delete", action: "delete-confirm", control: "button" });
					lines.push({ text: "Cancel delete", action: "delete-cancel", control: "button" });
				} else {
					lines.push({ text: "Delete task", action: "delete", control: "button" });
				}
			}
		}
		const footer = this.pendingDeleteId
			? "Click Confirm delete or Cancel delete · keyboard shortcuts remain available"
			: "Click a task, then use its action buttons · mouse wheel scrolls · Esc closes";
		return { title: "Tasks", subtitle: ".pi/tasks.jsonc", lines, footer };
	}

	handleInput(data: string): boolean {
		if (this.edit) return this.handleEditInput(data);
		if (data === "\x1b[A" || data === "k") return this.moveSelection(-1);
		if (data === "\x1b[B" || data === "j") return this.moveSelection(1);
		if (data === "a") {
			this.beginAdd();
			return true;
		}
		if (data === "e") {
			this.beginEdit();
			return true;
		}
		if (data === "s") {
			void this.cycleSelectedStatus();
			return true;
		}
		if (data === "t") {
			void this.cycleSelectedType();
			return true;
		}
		if (data === "J") {
			void this.moveSelectedTask(1);
			return true;
		}
		if (data === "K") {
			void this.moveSelectedTask(-1);
			return true;
		}
		if (data === "d") {
			void this.deleteSelected();
			return true;
		}
		if (data === "r") {
			void this.load();
			return true;
		}
		if (data === "\r" || data === "\n") {
			const selected = this.selectedTask();
			if (selected) void this.host.runTask(selected);
			return true;
		}
		if (data === "\x1b" && this.pendingDeleteId) {
			this.pendingDeleteId = undefined;
			return true;
		}
		return false;
	}

	async activate(action: string): Promise<void> {
		if (this.loading || this.saving) return;
		if (this.edit) {
			if (action === "edit-title") this.edit.field = "title";
			else if (action === "edit-description") this.edit.field = "description";
			else if (action === "edit-type") {
				this.edit.field = "type";
				this.edit.type = cycle(TASK_TYPES, this.edit.type, 1);
			} else if (action === "edit-status") {
				this.edit.field = "status";
				this.edit.status = cycle(TASK_STATUSES, this.edit.status, 1);
			} else if (action === "edit-save") await this.saveEdit();
			else if (action === "edit-cancel") this.edit = undefined;
			return;
		}
		if (action === "add") {
			this.beginAdd();
			return;
		}
		if (action === "refresh") {
			await this.load();
			return;
		}
		if (action === "run-selected") {
			const selected = this.selectedTask();
			if (selected) await this.host.runTask(selected);
			return;
		}
		if (action === "edit-selected") {
			this.beginEdit();
			return;
		}
		if (action === "status-next") {
			await this.cycleSelectedStatus();
			return;
		}
		if (action === "type-next") {
			await this.cycleSelectedType();
			return;
		}
		if (action === "move-up") {
			await this.moveSelectedTask(-1);
			return;
		}
		if (action === "move-down") {
			await this.moveSelectedTask(1);
			return;
		}
		if (action === "delete") {
			const selected = this.selectedTask();
			this.pendingDeleteId = selected?.id;
			return;
		}
		if (action === "delete-confirm") {
			await this.deleteSelected();
			return;
		}
		if (action === "delete-cancel") {
			this.pendingDeleteId = undefined;
			return;
		}
		if (!action.startsWith("task:")) return;
		const taskId = action.slice("task:".length);
		if (this.document.tasks.some((task) => task.id === taskId)) this.selectedTaskId = taskId;
	}

	private editSnapshot(): WorkspaceToolSurfaceSnapshot {
		const edit = this.edit!;
		return {
			title: edit.taskId ? "Edit task" : "Add task",
			subtitle: ".pi/tasks.jsonc",
			lines: [
				{
					text: `${edit.field === "title" ? "›" : " "} Title: ${edit.title || "(empty)"}`,
					variant: edit.field === "title" ? "accent" : "normal",
					action: "edit-title",
				},
				{
					text: `${edit.field === "description" ? "›" : " "} Description: ${edit.description || "(empty)"}`,
					variant: edit.field === "description" ? "accent" : "normal",
					action: "edit-description",
				},
				{ text: `Cycle type · ${typeLabel(edit.type)}`, action: "edit-type", control: "button" },
				{ text: `Cycle status · ${statusLabel(edit.status)}`, action: "edit-status", control: "button" },
				{ text: "Save task", action: "edit-save", control: "button" },
				{ text: "Cancel", action: "edit-cancel", control: "button" },
			],
			footer: "Click Title/Description to type · click cycle buttons for enums · Save/Cancel",
		};
	}

	private handleEditInput(data: string): boolean {
		const edit = this.edit;
		if (!edit) return false;
		if (data === "\x1b") {
			this.edit = undefined;
			return true;
		}
		if (data === "\r" || data === "\n" || data === "\t") {
			if (edit.field === "save") void this.saveEdit();
			else edit.field = nextEditField(edit.field);
			return true;
		}
		if (edit.field === "type" && (data === "\x1b[C" || data === "\x1b[D" || data === " ")) {
			edit.type = cycle(TASK_TYPES, edit.type, data === "\x1b[D" ? -1 : 1);
			return true;
		}
		if (edit.field === "status" && (data === "\x1b[C" || data === "\x1b[D" || data === " ")) {
			edit.status = cycle(TASK_STATUSES, edit.status, data === "\x1b[D" ? -1 : 1);
			return true;
		}
		if (edit.field !== "title" && edit.field !== "description") return true;
		if (data === "\u007f" || data === "\b") {
			if (edit.field === "title") edit.title = edit.title.slice(0, -1);
			else edit.description = edit.description.slice(0, -1);
			return true;
		}
		if ([...data].every((char) => char >= " " && char !== "\u007f")) {
			const value = data.replace(/[\r\n]/gu, " ");
			if (edit.field === "title") edit.title = `${edit.title}${value}`.slice(0, 200);
			else edit.description = `${edit.description}${value}`.slice(0, 10_000);
			return true;
		}
		return true;
	}

	private beginAdd(): void {
		this.pendingDeleteId = undefined;
		this.edit = { field: "title", title: "", description: "", type: "feature", status: "todo" };
	}

	private beginEdit(): void {
		const task = this.selectedTask();
		if (!task) return;
		this.pendingDeleteId = undefined;
		this.edit = {
			taskId: task.id,
			field: "title",
			title: task.title,
			description: task.description ?? "",
			type: task.type,
			status: task.status,
		};
	}

	private async saveEdit(): Promise<void> {
		const edit = this.edit;
		if (!edit || this.saving) return;
		const title = edit.title.trim();
		const description = edit.description.trim();
		if (!title && !description) {
			this.error = "Task needs a title or description.";
			this.edit = undefined;
			return;
		}
		const now = new Date().toISOString();
		let tasks: ProjectTask[];
		if (edit.taskId) {
			tasks = this.document.tasks.map((task) => {
				if (task.id !== edit.taskId) return task;
				const { description: _previousDescription, ...rest } = task;
				return {
					...rest,
					title,
					...(description ? { description } : {}),
					type: edit.type,
					status: edit.status,
					updatedAt: now,
				};
			});
		} else {
			const task: ProjectTask = {
				id: randomUUID(),
				title,
				...(description ? { description } : {}),
				type: edit.type,
				status: edit.status,
				priority: "medium",
				createdAt: now,
				updatedAt: now,
			};
			tasks = [task, ...this.document.tasks];
			this.selectedTaskId = task.id;
		}
		this.edit = undefined;
		await this.save({ ...this.document, tasks });
	}

	private async cycleSelectedStatus(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		const status = cycle(TASK_STATUSES, task.status, 1);
		await this.replaceTask(task.id, { ...task, status, updatedAt: new Date().toISOString() });
	}

	private async cycleSelectedType(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		const type = cycle(TASK_TYPES, task.type, 1);
		await this.replaceTask(task.id, { ...task, type, updatedAt: new Date().toISOString() });
	}

	private async moveSelectedTask(delta: number): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		const indexes = this.document.tasks.map((candidate, index) => candidate.type === task.type ? index : -1).filter((index) => index >= 0);
		const current = indexes.indexOf(this.document.tasks.findIndex((candidate) => candidate.id === task.id));
		const next = current + delta;
		if (current < 0 || next < 0 || next >= indexes.length) return;
		const sourceIndex = indexes[current]!;
		const targetIndex = indexes[next]!;
		const tasks = [...this.document.tasks];
		const [moved] = tasks.splice(sourceIndex, 1);
		if (!moved) return;
		tasks.splice(targetIndex, 0, moved);
		await this.save({ ...this.document, tasks });
	}

	private async deleteSelected(): Promise<void> {
		const task = this.selectedTask();
		if (!task) return;
		if (this.pendingDeleteId !== task.id) {
			this.pendingDeleteId = task.id;
			return;
		}
		this.pendingDeleteId = undefined;
		const index = this.document.tasks.findIndex((candidate) => candidate.id === task.id);
		const tasks = this.document.tasks.filter((candidate) => candidate.id !== task.id);
		this.selectedTaskId = tasks[Math.min(index, tasks.length - 1)]?.id;
		await this.save({ ...this.document, tasks });
	}

	private async replaceTask(taskId: string, next: ProjectTask): Promise<void> {
		await this.save({ ...this.document, tasks: this.document.tasks.map((task) => task.id === taskId ? next : task) });
	}

	private moveSelection(delta: number): boolean {
		const tasks = this.document.tasks;
		if (tasks.length === 0) return true;
		const index = this.selectedTaskId ? tasks.findIndex((task) => task.id === this.selectedTaskId) : -1;
		const next = index < 0 ? (delta > 0 ? 0 : tasks.length - 1) : (index + delta + tasks.length) % tasks.length;
		this.selectedTaskId = tasks[next]?.id;
		this.pendingDeleteId = undefined;
		return true;
	}

	private selectedTask(): ProjectTask | undefined {
		return this.document.tasks.find((task) => task.id === this.selectedTaskId) ?? this.document.tasks[0];
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		this.loading = true;
		this.error = undefined;
		this.host.render();
		try {
			const document = await readTasks(this.host.cwd);
			if (generation !== this.generation) return;
			this.document = document;
			if (!this.document.tasks.some((task) => task.id === this.selectedTaskId)) this.selectedTaskId = this.document.tasks[0]?.id;
		} catch (error) {
			if (generation === this.generation) this.error = errorMessage(error);
		} finally {
			if (generation === this.generation) {
				this.loading = false;
				this.host.render();
			}
		}
	}

	private async save(document: ProjectTasksSchemaType): Promise<void> {
		if (this.saving) return;
		const previous = this.document;
		this.document = document;
		this.saving = true;
		this.error = undefined;
		this.host.render();
		try {
			await writeTasks(this.host.cwd, document);
		} catch (error) {
			this.document = previous;
			this.error = errorMessage(error);
		} finally {
			this.saving = false;
			this.host.render();
		}
	}
}

async function readTasks(cwd: string): Promise<ProjectTasksSchemaType> {
	const path = join(cwd, ".pi", "tasks.jsonc");
	let source: string;
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new Error(".pi/tasks.jsonc is not a file");
		if (info.size > MAX_TASK_DOCUMENT_BYTES) throw new Error(".pi/tasks.jsonc is too large (maximum 1 MB)");
		source = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error, "ENOENT")) return { $schema: TASK_SCHEMA_URL, version: 1, tasks: [] };
		throw error;
	}
	const parsed = parseJsonc(source) as unknown;
	if (!Value.Check(ProjectTasksSchema, parsed)) throw new Error("Invalid .pi/tasks.jsonc");
	const document = parsed as ProjectTasksSchemaType;
	const ids = new Set<string>();
	for (const task of document.tasks) {
		if (!task.title.trim() && !task.description?.trim()) throw new Error(`Invalid task ${task.id}: title or description is required`);
		if (!Number.isFinite(Date.parse(task.createdAt)) || !Number.isFinite(Date.parse(task.updatedAt))) throw new Error(`Invalid task ${task.id}: timestamp`);
		if (ids.has(task.id)) throw new Error(`Invalid .pi/tasks.jsonc: duplicate task id ${task.id}`);
		ids.add(task.id);
	}
	return { ...document, $schema: document.$schema ?? TASK_SCHEMA_URL };
}

async function writeTasks(cwd: string, document: ProjectTasksSchemaType): Promise<void> {
	if (!Value.Check(ProjectTasksSchema, document)) throw new Error("Refusing to write an invalid task document");
	const directory = join(cwd, ".pi");
	try {
		await access(directory, fsConstants.W_OK);
	} catch {
		throw new Error("Project .pi directory is not initialized. Initialize project Registry state first.");
	}
	await mkdir(directory, { recursive: false }).catch((error) => {
		if (!isNodeError(error, "EEXIST")) throw error;
	});
	const path = join(directory, "tasks.jsonc");
	const serialized = `${JSON.stringify({ ...document, $schema: TASK_SCHEMA_URL }, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_TASK_DOCUMENT_BYTES) throw new Error(".pi/tasks.jsonc is too large (maximum 1 MB)");
	const temporary = join(directory, `.tasks.jsonc.${process.pid}.${Date.now()}.tmp`);
	await writeFile(temporary, serialized, "utf8");
	await rename(temporary, path);
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function taskLabel(task: ProjectTask): string {
	const title = task.title.trim();
	if (title) return title;
	return task.description?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? "Untitled task";
}

function statusIcon(status: ProjectTaskStatus): string {
	if (status === "done") return "✓";
	if (status === "in-progress") return "◐";
	if (status === "backlog") return "◌";
	return "○";
}

function typeLabel(type: ProjectTaskType): string {
	if (type === "bug") return "Bug";
	if (type === "feature") return "Feature";
	return "Improve";
}

function statusLabel(status: ProjectTaskStatus): string {
	if (status === "in-progress") return "In progress";
	return status.charAt(0).toUpperCase() + status.slice(1);
}

function nextEditField(field: EditField): EditField {
	if (field === "title") return "description";
	if (field === "description") return "type";
	if (field === "type") return "status";
	if (field === "status") return "save";
	return "save";
}

function cycle<T>(values: readonly T[], current: T, delta: number): T {
	const index = Math.max(0, values.indexOf(current));
	return values[(index + delta + values.length) % values.length] ?? current;
}

export function buildWorkspaceTaskPrompt(task: ProjectTask): string {
	const lines = ["Work on this project task.", "", `Type: ${typeLabel(task.type)}`];
	if (task.title.trim()) lines.push(`Task: ${task.title.trim()}`);
	if (task.description?.trim()) lines.push("", "Description:", task.description.trim());
	lines.push("", "Inspect the existing implementation, make the changes, and verify the result.");
	return lines.join("\n");
}
