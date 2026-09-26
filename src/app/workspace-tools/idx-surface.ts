import { access } from "node:fs/promises";
import { join } from "node:path";

import { commandExists, runProcess, type AsyncProcessResult, type RunProcessOptions } from "../process.js";
import type { WorkspaceToolSurface, WorkspaceToolSurfaceLine, WorkspaceToolSurfaceSnapshot } from "./workspace-tool-controller.js";

type IdxQueryKind = "code" | "documents" | "context";

export type IdxSurfaceHost = {
	cwd: string;
	render(): void;
};

export type IdxSurfaceDeps = {
	commandExists(command: string): Promise<boolean>;
	runProcess(command: string, args?: readonly string[], options?: RunProcessOptions): Promise<AsyncProcessResult>;
	exists(path: string): Promise<boolean>;
};

const DEFAULT_DEPS: IdxSurfaceDeps = { commandExists, runProcess, exists };

export class IdxWorkspaceToolSurface implements WorkspaceToolSurface {
	readonly id = "idx" as const;
	private loading = false;
	private running = false;
	private available = false;
	private initialized = false;
	private version: string | undefined;
	private statusText = "";
	private error: string | undefined;
	private queryKind: IdxQueryKind = "code";
	private queryText = "";
	private editingQuery = false;
	private output = "";
	private outputLabel = "";
	private scrollOffset = 0;
	private generation = 0;

	constructor(
		private readonly host: IdxSurfaceHost,
		private readonly deps: IdxSurfaceDeps = DEFAULT_DEPS,
	) {}

	async open(): Promise<void> {
		await this.refresh();
	}

	close(): void {
		this.generation += 1;
		this.editingQuery = false;
	}

	canClose(): boolean {
		return !this.running && !this.loading;
	}

	snapshot(): WorkspaceToolSurfaceSnapshot {
		const lines: WorkspaceToolSurfaceLine[] = [];
		if (this.loading) {
			lines.push({ text: "Reading IDX state…", variant: "muted" });
		} else if (!this.available) {
			lines.push({ text: "IDX is not available on PATH.", variant: "error" });
			lines.push({ text: "Install indexer-cli, then refresh.", variant: "muted" });
			lines.push({ text: "Refresh", action: "refresh", control: "button" });
		} else {
			lines.push({ text: `Version: ${this.version ?? "unknown"}`, variant: "muted" });
			lines.push({ text: `Project index: ${this.initialized ? "initialized" : "not initialized"}`, variant: this.initialized ? "normal" : "accent" });
			lines.push({ text: "Refresh", action: "refresh", control: "button" });
			if (!this.initialized) {
				lines.push({ text: "Initialize IDX", action: "initialize", control: "button" });
			} else {
				lines.push({ text: "Update index", action: "index-update", control: "button" });
				lines.push({ text: "Full reindex", action: "index-full", control: "button" });
				lines.push({ text: "Dry run", action: "index-dry-run", control: "button" });
				lines.push({ text: "Doctor", action: "doctor", control: "button" });
			}
			if (this.statusText.trim()) {
				lines.push({ text: "" });
				lines.push({ text: "Index status", variant: "accent" });
				for (const line of compactLines(this.statusText, 12)) lines.push({ text: line });
			}
		}

		lines.push({ text: "" });
		lines.push({ text: `Query mode: ${queryKindLabel(this.queryKind)}`, variant: "accent", action: "query-mode" });
		lines.push({ text: `Query: ${this.queryText || "(click to enter a query)"}`, variant: this.editingQuery ? "accent" : "muted", action: "query-edit" });
		if (this.editingQuery) {
			lines.push({ text: "Run query", action: "query-run", control: "button" });
			lines.push({ text: "Cancel query edit", action: "query-cancel", control: "button" });
		} else if (this.queryText.trim()) {
			lines.push({ text: "Run query", action: "query-run", control: "button" });
		}
		if (this.outputLabel) {
			lines.push({ text: "" });
			lines.push({ text: this.outputLabel, variant: "accent" });
			const outputLines = this.output.split(/\r?\n/u);
			for (const line of outputLines.slice(this.scrollOffset, this.scrollOffset + 120)) lines.push({ text: line || " " });
		}
		if (this.error) {
			lines.push({ text: "" });
			lines.push({ text: this.error, variant: "error" });
		}

		const footer = this.running
			? "Foreground IDX operation running — modal stays open until it completes"
			: this.editingQuery
				? "Type query text, then click Run query or Cancel query edit"
				: "Click controls to query or maintain IDX · mouse wheel scrolls output · Esc closes";
		return { title: "IDX", subtitle: "Repository intelligence", lines, footer };
	}

	handleInput(data: string): boolean {
		if (this.running || this.loading) return true;
		if (this.editingQuery) return this.handleQueryInput(data);
		if (data === "m") {
			this.queryKind = cycle(["code", "documents", "context"] as const, this.queryKind);
			return true;
		}
		if (data === "/") {
			this.editingQuery = true;
			return true;
		}
		if (data === "\r" || data === "\n") {
			if (this.queryText.trim()) void this.runQuery();
			else this.editingQuery = true;
			return true;
		}
		if (data === "r") {
			void this.refresh();
			return true;
		}
		if (data === "i") {
			void this.runMaintenance("Initialize IDX", ["init"], 10 * 60_000);
			return true;
		}
		if (data === "u") {
			void this.runMaintenance("Update index", ["index"], 10 * 60_000);
			return true;
		}
		if (data === "f") {
			void this.runMaintenance("Full reindex", ["index", "--full"], 20 * 60_000);
			return true;
		}
		if (data === "d") {
			void this.runMaintenance("Dry run", ["index", "--dry-run"], 10 * 60_000);
			return true;
		}
		if (data === "x") {
			void this.runMaintenance("IDX doctor", ["doctor", "--force", "."], 10 * 60_000);
			return true;
		}
		return false;
	}

	async activate(action: string): Promise<void> {
		if (this.running || this.loading) return;
		if (action === "refresh") {
			await this.refresh();
			return;
		}
		if (action === "query-mode") {
			this.queryKind = cycle(["code", "documents", "context"] as const, this.queryKind);
			return;
		}
		if (action === "query-edit") {
			this.editingQuery = true;
			return;
		}
		if (action === "query-cancel") {
			this.editingQuery = false;
			return;
		}
		if (action === "query-run") {
			this.editingQuery = false;
			await this.runQuery();
			return;
		}
		if (action === "initialize") {
			await this.runMaintenance("Initialize IDX", ["init"], 10 * 60_000);
			return;
		}
		if (action === "index-update") {
			await this.runMaintenance("Update index", ["index"], 10 * 60_000);
			return;
		}
		if (action === "index-full") {
			await this.runMaintenance("Full reindex", ["index", "--full"], 20 * 60_000);
			return;
		}
		if (action === "index-dry-run") {
			await this.runMaintenance("Dry run", ["index", "--dry-run"], 10 * 60_000);
			return;
		}
		if (action === "doctor") await this.runMaintenance("IDX doctor", ["doctor", "--force", "."], 10 * 60_000);
	}

	scroll(delta: number): void {
		const lineCount = this.output ? this.output.split(/\r?\n/u).length : 0;
		this.scrollOffset = Math.max(0, Math.min(Math.max(0, lineCount - 1), this.scrollOffset + delta));
	}

	private handleQueryInput(data: string): boolean {
		if (data === "\x1b") {
			this.editingQuery = false;
			return true;
		}
		if (data === "\r" || data === "\n") {
			this.editingQuery = false;
			if (this.queryText.trim()) void this.runQuery();
			return true;
		}
		if (data === "\u007f" || data === "\b") {
			this.queryText = this.queryText.slice(0, -1);
			return true;
		}
		if ([...data].every((char) => char >= " " && char !== "\u007f")) {
			this.queryText = `${this.queryText}${data}`.replace(/[\r\n]/gu, " ").slice(0, 4_000);
			return true;
		}
		return true;
	}

	private async refresh(): Promise<void> {
		if (this.running || this.loading) return;
		const generation = ++this.generation;
		this.loading = true;
		this.error = undefined;
		this.host.render();
		try {
			this.available = await this.deps.commandExists("idx");
			if (!this.available || generation !== this.generation) return;
			const version = await runIdx(this.deps, this.host.cwd, ["--version"], 10_000, 8 * 1024);
			if (generation !== this.generation) return;
			this.version = version.trim() || undefined;
			this.initialized = await this.deps.exists(join(this.host.cwd, ".indexer-cli"));
			if (!this.initialized) {
				this.statusText = "";
				return;
			}
			this.statusText = await runIdx(this.deps, this.host.cwd, ["index", "--status"], 30_000, 128 * 1024);
		} catch (error) {
			if (generation === this.generation) this.error = errorMessage(error);
		} finally {
			if (generation === this.generation) {
				this.loading = false;
				this.host.render();
			}
		}
	}

	private async runQuery(): Promise<void> {
		if (!this.available || !this.initialized || this.running || !this.queryText.trim()) {
			if (!this.initialized) this.error = "Initialize IDX before running repository queries.";
			return;
		}
		const query = this.queryText.trim();
		const args = queryArgs(this.queryKind, query);
		await this.runForeground(`Query · ${queryKindLabel(this.queryKind)}`, args, 120_000, 2 * 1024 * 1024, false);
	}

	private async runMaintenance(label: string, args: readonly string[], timeoutMs: number): Promise<void> {
		if (!this.available || this.running || this.loading) return;
		if (!this.initialized && args[0] !== "init") {
			this.error = "Initialize IDX first.";
			this.host.render();
			return;
		}
		await this.runForeground(label, args, timeoutMs, 2 * 1024 * 1024, true);
	}

	private async runForeground(
		label: string,
		args: readonly string[],
		timeoutMs: number,
		maxBufferBytes: number,
		refreshAfter: boolean,
	): Promise<void> {
		this.running = true;
		this.error = undefined;
		this.outputLabel = label;
		this.output = "Running…";
		this.scrollOffset = 0;
		this.host.render();
		try {
			const result = await this.deps.runProcess("idx", args, { cwd: this.host.cwd, timeoutMs, maxBufferBytes });
			const combined = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
			this.output = combined || (result.status === 0 ? "Completed." : "No output.");
			if (result.error) throw result.error;
			if (result.timedOut) throw new Error(`${label} timed out`);
			if (result.status !== 0) throw new Error(`${label} exited with code ${result.status ?? "unknown"}`);
			if (refreshAfter) {
				this.initialized = await this.deps.exists(join(this.host.cwd, ".indexer-cli"));
				if (this.initialized) {
					try {
						this.statusText = await runIdx(this.deps, this.host.cwd, ["index", "--status"], 30_000, 128 * 1024);
					} catch (error) {
						this.error = errorMessage(error);
					}
				}
			}
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.running = false;
			this.host.render();
		}
	}
}

function queryArgs(kind: IdxQueryKind, query: string): string[] {
	if (kind === "documents") return ["search", query, "--domain", "document", "--max-files", "10"];
	if (kind === "context") return ["context", query, "--budget", "3500", "--max-specs", "6", "--max-code", "10", "--max-tests", "6"];
	return ["search", query, "--domain", "code", "--max-files", "12", "--mode", "hybrid", "--include-content"];
}

async function runIdx(deps: IdxSurfaceDeps, cwd: string, args: readonly string[], timeoutMs: number, maxBufferBytes: number): Promise<string> {
	const result = await deps.runProcess("idx", args, { cwd, timeoutMs, maxBufferBytes });
	if (result.error) throw result.error;
	if (result.timedOut) throw new Error(`idx ${args.join(" ")} timed out`);
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `idx ${args.join(" ")} failed`);
	return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function queryKindLabel(kind: IdxQueryKind): string {
	if (kind === "documents") return "Documents";
	if (kind === "context") return "Context";
	return "Code";
}

function compactLines(text: string, limit: number): string[] {
	return text.split(/\r?\n/u).filter((line) => line.trim()).slice(0, limit);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function cycle<T>(values: readonly T[], current: T): T {
	const index = values.indexOf(current);
	return values[(Math.max(0, index) + 1) % values.length] ?? current;
}
