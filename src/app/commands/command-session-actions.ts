import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ContextUsage } from "@earendil-works/pi-coding-agent";
import type { CommandControllerHost } from "./command-host.js";
import { getIdleRuntime, getRuntime, parsePathArgument } from "./command-runtime.js";
import { createId } from "../id.js";
import { runProcess } from "../process.js";
import { copyTextToClipboard } from "../screen/clipboard.js";
import { formatAccountUsageReport, queryAccountUsageReport } from "../model/model-usage-status.js";
import type { SessionModel } from "../types.js";
import { checkPixUpdate, formatPixUpdateCheck, parsePixUpdateArgs, pixUpdateUsage } from "../cli/update.js";

export class SessionCommandActions {
	constructor(private readonly host: CommandControllerHost) {}

	async runExportCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "export");
		if (!runtime) return;

		const outputPath = parsePathArgument(argumentsText);
		const resolvedOutputPath = outputPath ? resolve(runtime.cwd, outputPath) : undefined;
		this.host.setStatus("exporting session");
		this.host.render();

		const filePath = resolvedOutputPath?.endsWith(".jsonl")
			? runtime.session.exportToJsonl(resolvedOutputPath)
			: await runtime.session.exportToHtml(resolvedOutputPath);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Session exported to: ${filePath}` });
		this.host.setSessionStatus(runtime.session);
		this.host.toast.success("Session exported");
	}

	async runImportCommand(argumentsText: string): Promise<void> {
		const runtime = getIdleRuntime(this.host, "import");
		if (!runtime) return;

		const inputPath = parsePathArgument(argumentsText);
		if (!inputPath) throw new Error("Usage: /import <path.jsonl>");

		const resolvedInputPath = resolve(runtime.cwd, inputPath);
		this.host.setStatus("importing session");
		this.host.render();

		const result = await runtime.importFromJsonl(resolvedInputPath);
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Import cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.afterSessionReplacement(`Session imported from: ${resolvedInputPath}`);
	}

	async runShareCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "share");
		if (!runtime) return;

		const authResult = await runProcess("gh", ["auth", "status"], { maxBufferBytes: 32 * 1024 });
		if (authResult.status !== 0) throw new Error("GitHub CLI is not installed or is not logged in. Run `gh auth login` first.");

		const shareDir = join(getAgentDir(), "pix");
		await mkdir(shareDir, { recursive: true });
		const tmpFile = join(shareDir, `session-share-${randomUUID()}.html`);
		try {
			this.host.setStatus("creating share gist");
			this.host.render();
			await runtime.session.exportToHtml(tmpFile);
			const gistResult = await runProcess("gh", ["gist", "create", "--public=false", tmpFile], { maxBufferBytes: 64 * 1024 });
			if (gistResult.status !== 0) throw new Error(gistResult.stderr?.trim() || "Failed to create gist");

			const gistUrl = gistResult.stdout.trim();
			this.host.addEntry({ id: createId("system"), kind: "system", text: `Shared session gist: ${gistUrl}` });
			this.host.setSessionStatus(runtime.session);
			this.host.toast.success("Session shared");
		} finally {
			await rm(tmpFile, { force: true }).catch(() => undefined);
		}
	}

	async runCopyCommand(): Promise<void> {
		const runtime = getRuntime(this.host, "copy");
		if (!runtime) return;

		const text = runtime.session.getLastAssistantText();
		if (!text) throw new Error("No agent messages to copy yet");

		await copyTextToClipboard(text);
		this.host.addEntry({ id: createId("system"), kind: "system", text: "Copied last agent message to clipboard." });
		this.host.setSessionStatus(runtime.session);
		this.host.toast.success("Copied last agent message");
	}

	async runNameCommand(argumentsText: string): Promise<void> {
		const runtime = getRuntime(this.host, "name");
		if (!runtime) return;

		const name = argumentsText.trim();
		if (!name) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: `Session name: ${runtime.session.sessionName ?? "(none)"}` });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		runtime.session.setSessionName(name);
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Session name set: ${name}` });
		this.host.setSessionStatus(runtime.session);
		this.host.render();
	}

	async runSessionInfoCommand(): Promise<void> {
		const runtime = getRuntime(this.host, "session");
		if (!runtime) return;

		const stats = runtime.session.getSessionStats();
		const lines = [
			"Session info",
			...(runtime.session.sessionName ? [`name: ${runtime.session.sessionName}`] : []),
			`file: ${stats.sessionFile ?? "in-memory"}`,
			`id: ${stats.sessionId}`,
			"",
			"Messages",
			`user: ${stats.userMessages.toLocaleString()}`,
			`assistant: ${stats.assistantMessages.toLocaleString()}`,
			`tool calls: ${stats.toolCalls.toLocaleString()}`,
			`tool results: ${stats.toolResults.toLocaleString()}`,
			`total: ${stats.totalMessages.toLocaleString()}`,
			"",
			"Tokens",
			`input: ${stats.tokens.input.toLocaleString()}`,
			`output: ${stats.tokens.output.toLocaleString()}`,
			`cache read: ${stats.tokens.cacheRead.toLocaleString()}`,
			`cache write: ${stats.tokens.cacheWrite.toLocaleString()}`,
			`total: ${stats.tokens.total.toLocaleString()}`,
			...(stats.cost > 0 ? ["", `cost: ${stats.cost.toFixed(4)}`] : []),
		];
		this.host.addEntry({ id: createId("system"), kind: "system", text: lines.join("\n") });
		this.host.setSessionStatus(runtime.session);
	}

	async runUsageCommand(): Promise<void> {
		const runtime = getRuntime(this.host, "usage");
		if (!runtime) return;

		this.host.setStatus("loading usage");
		this.host.render();

		const accountReport = await queryAccountUsageReport();
		const accountUsage = formatAccountUsageReport(accountReport);
		if (accountUsage) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: accountUsage });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		const stats = runtime.session.getSessionStats();
		const contextUsage = stats.contextUsage ?? runtime.session.getContextUsage();
		const model = runtime.session.model ? this.host.modelRef(runtime.session.model as SessionModel) : "not selected";
		const lines = [
			"Usage",
			`model: ${model}`,
			"",
			"Tokens",
			`input: ${stats.tokens.input.toLocaleString()}`,
			`output: ${stats.tokens.output.toLocaleString()}`,
			`cache read: ${stats.tokens.cacheRead.toLocaleString()}`,
			`cache write: ${stats.tokens.cacheWrite.toLocaleString()}`,
			`total: ${stats.tokens.total.toLocaleString()}`,
			...(stats.cost > 0 ? [`cost: ${stats.cost.toFixed(4)}`] : []),
			"",
			"Context",
			...this.formatContextUsageLines(contextUsage),
		];

		this.host.addEntry({ id: createId("system"), kind: "system", text: lines.join("\n") });
		this.host.setSessionStatus(runtime.session);
	}

	async runChangelogCommand(): Promise<void> {
		const changelogPath = join(this.piPackageRoot(), "CHANGELOG.md");
		const raw = await readFile(changelogPath, "utf8");
		const lines = raw.trim().split(/\r?\n/).slice(0, 140);
		this.host.addEntry({ id: createId("system"), kind: "system", text: lines.join("\n") });
		this.host.setSessionStatus(this.host.runtime()?.session);
	}

	async runUpdateCommand(argumentsText: string): Promise<void> {
		const runtime = getRuntime(this.host, "update");
		if (!runtime) return;

		const options = parsePixUpdateArgs(splitUpdateArguments(argumentsText));
		if (options.help) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: pixUpdateUsage() });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.setStatus("checking updates");
		this.host.render();

		const result = await checkPixUpdate();
		const forceHint = options.force ? "\n\n/update is check-only. To force a reinstall, run `pix update --force` in your shell and restart Pix." : "";
		this.host.addEntry({ id: createId("system"), kind: "system", text: `${formatPixUpdateCheck(result)}${forceHint}` });
		this.host.setSessionStatus(runtime.session);
		if (result.status === "newer") this.host.toast.info("Pix update available");
		else if (result.status === "current") this.host.toast.success("Pix is up to date");
		else this.host.toast.warning("Pix update check incomplete");
	}

	async runHotkeysCommand(): Promise<void> {
		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: [
				"Keyboard shortcuts",
				"Enter: send message / run selected command",
				"!command: run a local shell command in chat (not saved to the session)",
				"while shell is running: Enter sends editor text to stdin; Ctrl-C interrupts; !!command uses the raw terminal",
				"Tab: autocomplete selected popup item",
				"Esc: close popup; abort running work when input is empty",
				"Up/Down: history or popup navigation",
				"PageUp/PageDown or Cmd+Up/Cmd+Down: scroll conversation by page",
				"Mouse wheel or right scrollbar: scroll conversation/popup",
				"/enhance or status magic-wand icon: improve the current prompt draft",
				"Status model/thinking/session/enhance/voice areas are clickable when shown.",
			].join("\n"),
		});
		this.host.setSessionStatus(this.host.runtime()?.session);
	}

	async runReloadCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "reload");
		if (!runtime) return;

		this.host.setStatus("reloading");
		this.host.render();
		try {
			await runtime.session.reload();
			this.host.setSessionStatus(runtime.session);
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Reloaded keybindings, extensions, skills, prompts, themes" });
			this.host.toast.success("Reloaded resources");
		} catch (error) {
			this.host.setSessionStatus(runtime.session);
			this.host.addEntry({ id: createId("error"), kind: "error", text: `Reload failed: ${error instanceof Error ? error.message : String(error)}` });
			this.host.toast.error("Reload failed");
		}
	}

	async runNewSessionCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "new");
		if (!runtime) return;

		this.host.setStatus("starting new session");
		this.host.render();
		const result = await runtime.newSession();
		if (result.cancelled) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "New session cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.resetSessionView();
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Started a new session. cwd=${runtime.cwd}` });
		if (runtime.modelFallbackMessage) this.host.addEntry({ id: createId("system"), kind: "system", text: runtime.modelFallbackMessage });
		for (const diag of runtime.diagnostics ?? []) {
			const kind = diag.type === "error" ? "error" as const : "system" as const;
			this.host.addEntry({ id: createId("system"), kind, text: `[${diag.type}] ${diag.message}` });
		}
		this.host.setSessionStatus(runtime.session);
	}

	async runCompactCommand(customInstructions?: string): Promise<void> {
		const runtime = getRuntime(this.host, "compact");
		if (!runtime) return;

		if (runtime.session.isCompacting) {
			this.host.toast.warning("Compaction already running");
			return;
		}

		this.host.setStatus(customInstructions ? "compacting with instructions" : "compacting");
		this.host.render();

		const result = await runtime.session.compact(customInstructions);
		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: `Compacted context (${result.tokensBefore} tokens before compaction).`,
		});
		this.host.setSessionStatus(runtime.session);
		this.host.toast.success(`Compacted ${result.tokensBefore} tokens`);
	}

	private piPackageRoot(): string {
		return dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	}

	private formatContextUsageLines(usage: ContextUsage | undefined): string[] {
		if (!usage) return ["unavailable"];

		const tokens = usage.tokens == null ? "unknown" : usage.tokens.toLocaleString();
		const percent = usage.percent == null ? "unknown" : `${trimDecimal(usage.percent)}%`;
		return [
			`tokens: ${tokens}`,
			`window: ${usage.contextWindow.toLocaleString()}`,
			`used: ${percent}`,
		];
	}
}

function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function splitUpdateArguments(argumentsText: string): string[] {
	const trimmed = argumentsText.trim();
	return trimmed ? trimmed.split(/\s+/u) : [];
}
