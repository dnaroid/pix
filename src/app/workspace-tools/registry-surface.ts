import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RegistryCommandResult } from "./registry-command-runner.js";
import type { WorkspaceToolSurface, WorkspaceToolSurfaceLine, WorkspaceToolSurfaceSnapshot } from "./workspace-tool-controller.js";

type RegistryItemType = "skill" | "agent" | "project";
type RegistryProjectArtifact = "tasks" | "plans" | "todo" | "workspace";
type RegistryItem = {
	type: RegistryItemType;
	name: string;
	status: string;
	artifact?: RegistryProjectArtifact;
	raw: string;
};

type ConfigureState = {
	kind: "remote" | "project-key";
	field: "remote" | "branch" | "key";
	remote: string;
	branch: string;
	key: string;
};

export type RegistrySurfaceHost = {
	cwd: string;
	render(): void;
	runRegistryCommand(args: string): Promise<RegistryCommandResult>;
};

export class RegistryWorkspaceToolSurface implements WorkspaceToolSurface {
	readonly id = "registry" as const;
	private loading = false;
	private running = false;
	private error: string | undefined;
	private notice: string | undefined;
	private statusText = "";
	private items: RegistryItem[] = [];
	private selected = 0;
	private configure: ConfigureState | undefined;
	private pendingDanger: string | undefined;
	private generation = 0;

	constructor(private readonly host: RegistrySurfaceHost) {}

	async open(): Promise<void> {
		await this.refresh();
	}

	close(): void {
		this.generation += 1;
		this.configure = undefined;
		this.pendingDanger = undefined;
	}

	canClose(): boolean {
		return !this.loading && !this.running;
	}

	snapshot(): WorkspaceToolSurfaceSnapshot {
		if (this.configure) return this.configureSnapshot();
		const lines: WorkspaceToolSurfaceLine[] = [];
		if (this.loading) {
			lines.push({ text: "Checking resource registry…", variant: "muted" });
		} else {
			lines.push({ text: "Refresh", action: "refresh", control: "button" });
			lines.push({ text: "Configure Registry", action: "configure", control: "button" });
			lines.push({ text: "Set project key", action: "project-key", control: "button" });
			lines.push({ text: "Initialize project .pi", action: "initialize", control: "button" });
			lines.push({ text: "" });
		}
		if (!this.loading && this.statusText) {
			for (const [index, line] of this.statusText.split(/\r?\n/u).entries()) {
				const itemIndex = this.items.findIndex((item) => item.raw === line);
				lines.push({
					text: itemIndex >= 0 ? `${itemIndex === this.selected ? "›" : " "} ${stripRegistryMarkdown(line)}` : stripRegistryMarkdown(line),
					variant: itemIndex === this.selected ? "accent" : index === 0 ? "accent" : "normal",
					...(itemIndex >= 0 ? { action: `item:${itemIndex}` } : {}),
				});
			}
		} else if (!this.loading) {
			lines.push({ text: "Registry data is not loaded yet.", variant: "muted" });
		}
		const selected = this.items[this.selected];
		if (!this.loading && selected) {
			lines.push({ text: "" });
			lines.push({ text: `Selected · ${selected.name} · ${selected.status}`, variant: "accent" });
			const primary = primaryAction(selected);
			if (primary) lines.push({ text: primaryActionLabel(primary), action: "primary", control: "button" });
			if (selected.type !== "project") {
				if (this.pendingDanger === "u") {
					lines.push({ text: "Confirm uninstall", action: "danger-confirm", control: "button" });
					lines.push({ text: "Cancel uninstall", action: "danger-cancel", control: "button" });
				} else if (this.pendingDanger === "D") {
					lines.push({ text: "Confirm remove from Registry", action: "danger-confirm", control: "button" });
					lines.push({ text: "Cancel remove", action: "danger-cancel", control: "button" });
				} else {
					lines.push({ text: "Uninstall local resource", action: "danger-uninstall", control: "button" });
					lines.push({ text: "Remove from Registry", action: "danger-remove", control: "button" });
				}
			}
		}
		if (this.notice) {
			lines.push({ text: "" });
			lines.push({ text: this.notice, variant: "accent" });
		}
		if (this.error) {
			lines.push({ text: "" });
			lines.push({ text: this.error, variant: "error" });
		}
		const footer = this.running
			? "Foreground Registry action running — modal stays open until it completes"
			: this.pendingDanger
				? "Confirm or cancel with the visible buttons · Esc also cancels"
				: "Click a resource, then use its action buttons · mouse wheel scrolls · Esc closes";
		return { title: "Registry", subtitle: "Resource registry", lines, footer };
	}

	handleInput(data: string): boolean {
		if (this.running || this.loading) return true;
		if (this.configure) return this.handleConfigureInput(data);
		if (this.pendingDanger && data === "\x1b") {
			this.pendingDanger = undefined;
			return true;
		}
		if (data === "\x1b[A" || data === "k") return this.moveSelection(-1);
		if (data === "\x1b[B" || data === "j") return this.moveSelection(1);
		if (data === "r") {
			void this.refresh();
			return true;
		}
		if (data === "c") {
			this.configure = { kind: "remote", field: "remote", remote: "", branch: "main", key: "" };
			return true;
		}
		if (data === "K") {
			this.configure = { kind: "project-key", field: "key", remote: "", branch: "main", key: "" };
			return true;
		}
		if (data === "I") {
			void this.initializeProject();
			return true;
		}
		if (data === "\r" || data === "\n") {
			void this.runPrimaryAction();
			return true;
		}
		if (data === "u") {
			void this.runDangerousResourceAction("u", "uninstall");
			return true;
		}
		if (data === "D") {
			void this.runDangerousResourceAction("D", "remove");
			return true;
		}
		return false;
	}

	async activate(action: string): Promise<void> {
		if (this.running || this.loading) return;
		if (this.configure) {
			const state = this.configure;
			if (action === "configure-remote" && state.kind === "remote") state.field = "remote";
			else if (action === "configure-branch" && state.kind === "remote") state.field = "branch";
			else if (action === "configure-key" && state.kind === "project-key") state.field = "key";
			else if (action === "configure-save") await this.saveConfigure();
			else if (action === "configure-cancel") this.configure = undefined;
			return;
		}
		if (action === "refresh") {
			await this.refresh();
			return;
		}
		if (action === "configure") {
			this.configure = { kind: "remote", field: "remote", remote: "", branch: "main", key: "" };
			return;
		}
		if (action === "project-key") {
			this.configure = { kind: "project-key", field: "key", remote: "", branch: "main", key: "" };
			return;
		}
		if (action === "initialize") {
			await this.initializeProject();
			return;
		}
		if (action === "primary") {
			await this.runPrimaryAction();
			return;
		}
		if (action === "danger-uninstall") {
			this.pendingDanger = "u";
			return;
		}
		if (action === "danger-remove") {
			this.pendingDanger = "D";
			return;
		}
		if (action === "danger-confirm") {
			if (this.pendingDanger === "u") await this.runDangerousResourceAction("u", "uninstall");
			else if (this.pendingDanger === "D") await this.runDangerousResourceAction("D", "remove");
			return;
		}
		if (action === "danger-cancel") {
			this.pendingDanger = undefined;
			return;
		}
		if (!action.startsWith("item:")) return;
		const index = Number(action.slice("item:".length));
		if (Number.isInteger(index) && index >= 0 && index < this.items.length) {
			this.selected = index;
			this.pendingDanger = undefined;
		}
	}

	private configureSnapshot(): WorkspaceToolSurfaceSnapshot {
		const state = this.configure!;
		if (state.kind === "project-key") {
			return {
				title: "Registry project key",
				lines: [
					{ text: `› Key: ${state.key || "(blank = auto from Git origin)"}`, variant: "accent", action: "configure-key" },
					{ text: "Save project key", action: "configure-save", control: "button" },
					{ text: "Cancel", action: "configure-cancel", control: "button" },
				],
				footer: "Click Key to type · Save/Cancel with mouse",
			};
		}
		return {
			title: "Configure Registry",
			lines: [
				{ text: `${state.field === "remote" ? "›" : " "} Remote: ${state.remote || "(enter Git URL/path)"}`, variant: state.field === "remote" ? "accent" : "normal", action: "configure-remote" },
				{ text: `${state.field === "branch" ? "›" : " "} Branch: ${state.branch}`, variant: state.field === "branch" ? "accent" : "normal", action: "configure-branch" },
				{ text: "Save Registry config", action: "configure-save", control: "button" },
				{ text: "Cancel", action: "configure-cancel", control: "button" },
			],
			footer: "Click Remote/Branch to edit · Save/Cancel with mouse",
		};
	}

	private handleConfigureInput(data: string): boolean {
		const state = this.configure;
		if (!state) return false;
		if (data === "\x1b") {
			this.configure = undefined;
			return true;
		}
		if (data === "\r" || data === "\n") {
			if (state.kind === "remote" && state.field === "remote") {
				state.field = "branch";
				return true;
			}
			void this.saveConfigure();
			return true;
		}
		if (data === "\u007f" || data === "\b") {
			if (state.field === "remote") state.remote = state.remote.slice(0, -1);
			else if (state.field === "branch") state.branch = state.branch.slice(0, -1);
			else state.key = state.key.slice(0, -1);
			return true;
		}
		if ([...data].every((char) => char >= " " && char !== "\u007f")) {
			const text = data.replace(/[\r\n]/gu, "");
			if (state.field === "remote") state.remote = `${state.remote}${text}`.slice(0, 2048);
			else if (state.field === "branch") state.branch = `${state.branch}${text}`.slice(0, 128);
			else state.key = `${state.key}${text}`.slice(0, 128);
			return true;
		}
		return true;
	}

	private async saveConfigure(): Promise<void> {
		const state = this.configure;
		if (!state) return;
		this.configure = undefined;
		if (state.kind === "project-key") {
			await this.runCommand(`project-key ${state.key.trim() || "auto"}`);
			return;
		}
		const remote = state.remote.trim();
		const branch = state.branch.trim() || "main";
		if (!remote || /\s/u.test(remote) || /\s/u.test(branch)) {
			this.error = "Registry remote and branch must be non-empty single arguments.";
			return;
		}
		await this.runCommand(`configure ${remote} ${branch}`);
	}

	private moveSelection(delta: number): boolean {
		if (this.items.length === 0) return true;
		this.selected = (this.selected + delta + this.items.length) % this.items.length;
		this.pendingDanger = undefined;
		return true;
	}

	private async runPrimaryAction(): Promise<void> {
		const item = this.items[this.selected];
		if (!item) return;
		const action = primaryAction(item);
		if (!action) {
			this.notice = `No safe primary action for ${item.name} (${item.status}).`;
			return;
		}
		await this.runCommand(registryActionCommand(item, action));
	}

	private async runDangerousResourceAction(key: string, action: "uninstall" | "remove"): Promise<void> {
		const item = this.items[this.selected];
		if (!item || item.type === "project") return;
		if (this.pendingDanger !== key) {
			this.pendingDanger = key;
			return;
		}
		this.pendingDanger = undefined;
		await this.runCommand(`${action} ${item.type} ${item.name}`);
	}

	private async initializeProject(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.error = undefined;
		this.notice = undefined;
		this.host.render();
		try {
			const piDir = join(this.host.cwd, ".pi");
			await mkdir(join(piDir, "plans"), { recursive: true });
			await mkdir(join(piDir, "task-attachments"), { recursive: true });
			const tasksPath = join(piDir, "tasks.jsonc");
			try {
				const info = await stat(tasksPath);
				if (!info.isFile()) throw new Error(".pi/tasks.jsonc exists but is not a file");
			} catch (error) {
				if (!isNodeError(error, "ENOENT")) throw error;
				await writeFile(tasksPath, `${JSON.stringify({ $schema: "https://unpkg.com/pi-ui-extend/schemas/tasks.json", version: 1, tasks: [] }, null, 2)}\n`, { flag: "wx" });
			}
			this.notice = "Initialized project .pi task/plans/task-attachments scaffold.";
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.running = false;
			this.host.render();
		}
		await this.refresh(true);
	}

	private async refresh(preserveNotice = false): Promise<void> {
		if (this.running || this.loading) return;
		const generation = ++this.generation;
		this.loading = true;
		this.error = undefined;
		if (!preserveNotice) this.notice = undefined;
		this.host.render();
		try {
			const result = await this.host.runRegistryCommand("status");
			if (generation !== this.generation) return;
			this.applyResult(result);
		} catch (error) {
			if (generation === this.generation) this.error = errorMessage(error);
		} finally {
			if (generation === this.generation) {
				this.loading = false;
				this.host.render();
			}
		}
	}

	private async runCommand(args: string): Promise<void> {
		if (this.running || this.loading) return;
		this.running = true;
		this.error = undefined;
		this.notice = undefined;
		this.host.render();
		try {
			const result = await this.host.runRegistryCommand(args);
			this.notice = result.lines.filter(Boolean).join(" · ") || `${args} completed.`;
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.running = false;
			this.host.render();
		}
		await this.refresh(true);
	}

	private applyResult(result: RegistryCommandResult): void {
		this.statusText = result.statusText ?? result.lines.join("\n");
		this.items = parseRegistryItems(this.statusText);
		if (this.selected >= this.items.length) this.selected = Math.max(0, this.items.length - 1);
		if (result.errors.length > 0) this.error = result.errors.join("\n");
		else if (!result.statusText && result.lines.length > 0) this.error = result.lines.join("\n");
	}
}

function parseRegistryItems(text: string): RegistryItem[] {
	return text.split(/\r?\n/u).flatMap((raw): RegistryItem[] => {
		const match = /^\s*[✓↓↑↕·+?!×]\s+(.+?)\s{2,}\[(SKILL|AGENT|PROJECT)\]\s{2,}\*\*(.+?)\*\*\s*$/u.exec(raw);
		if (!match) return [];
		const name = match[1]!.trim();
		const type = match[2]!.toLowerCase() as RegistryItemType;
		const artifact = type === "project" ? projectArtifact(name) : undefined;
		return [{ type, name, status: match[3]!.trim(), ...(artifact ? { artifact } : {}), raw }];
	});
}

function projectArtifact(name: string): RegistryProjectArtifact | undefined {
	if (name === "tasks.jsonc") return "tasks";
	if (name === "plans/") return "plans";
	if (name === "TODO.md") return "todo";
	if (name === "workspace.jsonc") return "workspace";
	return undefined;
}

function primaryAction(item: RegistryItem): "install" | "update" | "push" | "pull" | undefined {
	if (item.type === "project") {
		if (["NOT INSTALLED", "OUTDATED", "MISSING LOCALLY"].includes(item.status)) return "pull";
		if (["LOCAL CHANGES", "LOCAL ONLY", "REMOVED FROM REGISTRY", "UNTRACKED LOCAL"].includes(item.status)) return "push";
		return undefined;
	}
	if (item.status === "NOT INSTALLED") return "install";
	if (["OUTDATED", "MISSING LOCALLY"].includes(item.status)) return "update";
	if (["LOCAL CHANGES", "LOCAL ONLY", "UNTRACKED LOCAL", "REMOVED FROM REGISTRY"].includes(item.status)) return "push";
	return undefined;
}

function primaryActionLabel(action: "install" | "update" | "push" | "pull"): string {
	if (action === "install") return "Install";
	if (action === "update") return "Update";
	if (action === "push") return "Push to Registry";
	return "Pull from Registry";
}

function registryActionCommand(item: RegistryItem, action: "install" | "update" | "push" | "pull"): string {
	if (item.type === "project") {
		if (!item.artifact) throw new Error(`Unknown project Registry artifact: ${item.name}`);
		return `${action} ${item.artifact}`;
	}
	return `${action} ${item.type} ${item.name}`;
}

function stripRegistryMarkdown(line: string): string {
	return line.replace(/\*\*/gu, "");
}

function isNodeError(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
