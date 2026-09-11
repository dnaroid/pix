import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import { getPixConfigPath, getProjectPixConfigPath } from "../../config.js";
import { createId } from "../id.js";
import { parseModelRef } from "../model/model-ref.js";
import { runProcess, type AsyncProcessResult, type RunProcessOptions } from "../process.js";
import type { SessionModel } from "../types.js";
import {
	captureCommandScope,
	isCommandScopeActive,
	type CommandControllerHost,
} from "./command-host.js";
import { getIdleRuntime } from "./command-runtime.js";

const GIT_REVIEW_TIMEOUT_MS = 120_000;
const GIT_COMMIT_MESSAGE_TIMEOUT_MS = 45_000;
const GIT_REVIEW_MAX_TOKENS = 4_096;
const GIT_COMMIT_MESSAGE_MAX_TOKENS = 768;
const GIT_DIFF_MAX_CHARS = 200_000;
const UNTRACKED_FILE_MAX_BYTES = 128 * 1024;
const DEFAULT_GIT_REVIEW_MODEL = "openai-codex/gpt-5.6-luna:medium";
const DEFAULT_GIT_COMMIT_MESSAGE_MODEL = "openai-codex/gpt-5.6-luna:minimal";

const REVIEW_SYSTEM_PROMPT = `You review Git diffs as a senior software engineer.

Focus on correctness, regressions, edge cases, security, data loss, concurrency, and missing tests.
Report concrete findings in descending severity and include file/line context when the diff provides it.
Do not invent problems or request unrelated refactors.
Do not flag a deletion merely because code or functionality was removed. Report a deletion only when the diff gives concrete evidence of a surviving broken reference, violated contract, unintended data loss/security impact, or another specific regression.
If there are no significant findings, say that clearly and briefly.
Return concise Markdown suitable for a code-review panel.`;

const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write Git commit messages from staged diffs.

Write an imperative subject line no longer than 72 characters.
Add a short body only when it materially improves understanding.
Describe what changed and why, not implementation trivia.
Output only the final commit message. Do not use Markdown fences or commentary.`;

export type GitAssistantKind = "review" | "commit-message";

type GitProcessRunner = (
	command: string,
	args?: readonly string[],
	options?: RunProcessOptions,
) => Promise<AsyncProcessResult>;

type GitAssistantRunner = (
	runtime: AgentSessionRuntime,
	kind: GitAssistantKind,
	diff: string,
) => Promise<string>;

export type GitCommandActionsDeps = {
	runProcess?: GitProcessRunner;
	generateGitAssistantText?: GitAssistantRunner;
};

export class GitCommandActions {
	private readonly runProcess: GitProcessRunner;
	private readonly generateGitAssistantText: GitAssistantRunner;

	constructor(
		private readonly host: CommandControllerHost,
		deps: GitCommandActionsDeps = {},
	) {
		this.runProcess = deps.runProcess ?? runProcess;
		this.generateGitAssistantText = deps.generateGitAssistantText ?? generateGitAssistantText;
	}

	async runCodeReviewCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "code-review");
		if (!runtime) return;
		const scope = captureCommandScope(this.host);

		this.host.setStatus("collecting Git changes");
		this.host.render();
		const root = await this.gitRoot(runtime.cwd);
		if (!isCommandScopeActive(this.host, scope)) return;
		const diff = await this.reviewInput(root);
		if (!isCommandScopeActive(this.host, scope)) return;
		if (!diff.trim()) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "No Git changes to review." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		this.host.setStatus("reviewing Git changes");
		this.host.render();
		const review = await this.generateGitAssistantText(runtime, "review", diff);
		if (!isCommandScopeActive(this.host, scope)) return;
		this.host.addEntry({ id: createId("system"), kind: "system", text: `Code review\n\n${review}` });
		this.host.setSessionStatus(runtime.session);
		this.host.toast.success("Code review complete");
	}

	async runCommitMessageCommand(): Promise<void> {
		const runtime = getIdleRuntime(this.host, "commit-message");
		if (!runtime) return;
		const scope = captureCommandScope(this.host);

		this.host.setStatus("reading staged changes");
		this.host.render();
		const root = await this.gitRoot(runtime.cwd);
		if (!isCommandScopeActive(this.host, scope)) return;
		const stagedDiff = await this.trackedDiff(root, true);
		if (!isCommandScopeActive(this.host, scope)) return;
		if (!stagedDiff.trim()) {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "There are no staged changes to commit." });
			this.host.setSessionStatus(runtime.session);
			this.host.toast.info("No staged changes");
			return;
		}

		this.host.setStatus("generating commit message");
		this.host.render();
		const message = await this.generateGitAssistantText(runtime, "commit-message", capGitInput(stagedDiff));
		if (!isCommandScopeActive(this.host, scope)) return;
		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: `Generated commit message\n\n${message}`,
		});
		this.host.setSessionStatus(runtime.session);

		const action = await this.host.showMenu<"commit" | "cancel">(
			[
				{
					value: "commit",
					label: "Commit staged changes",
					description: firstLine(message),
					variant: "accent",
				},
				{ value: "cancel", label: "Cancel" },
			],
			{ title: "Create Git commit?", searchable: false, preserveStatus: true },
		);
		if (!isCommandScopeActive(this.host, scope)) return;
		if (action !== "commit") {
			this.host.addEntry({ id: createId("system"), kind: "system", text: "Commit cancelled." });
			this.host.setSessionStatus(runtime.session);
			return;
		}

		const currentStagedDiff = await this.trackedDiff(root, true);
		if (!isCommandScopeActive(this.host, scope)) return;
		if (currentStagedDiff !== stagedDiff) {
			this.host.addEntry({
				id: createId("error"),
				kind: "error",
				text: "Staged changes changed after the commit message was generated. Run /commit-message again before committing.",
			});
			this.host.setSessionStatus(runtime.session);
			this.host.toast.warning("Staged changes changed");
			return;
		}

		this.host.setStatus("creating Git commit");
		this.host.render();
		const result = await this.runProcess("git", ["commit", "-F", "-"], {
			cwd: root,
			input: `${message.trim()}\n`,
			timeoutMs: 120_000,
			maxBufferBytes: 256 * 1024,
		});
		if (!isCommandScopeActive(this.host, scope)) return;
		if (result.status !== 0) {
			throw new Error(gitFailureMessage("git commit", result));
		}

		const detail = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
		this.host.addEntry({
			id: createId("system"),
			kind: "system",
			text: detail ? `Git commit created\n\n${detail}` : "Git commit created.",
		});
		this.host.setSessionStatus(runtime.session);
		this.host.toast.success("Git commit created");
	}

	private async gitRoot(cwd: string): Promise<string> {
		const result = await this.runProcess("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeoutMs: 10_000,
			maxBufferBytes: 16 * 1024,
		});
		if (result.status !== 0) throw new Error(gitFailureMessage("git rev-parse", result));
		const root = result.stdout.trim();
		if (!root) throw new Error("Git repository root is unavailable");
		return root;
	}

	private async trackedDiff(root: string, staged: boolean): Promise<string> {
		const args = ["diff", ...(staged ? ["--cached"] : []), "--no-ext-diff", "--no-color", "--minimal"];
		const result = await this.runProcess("git", args, {
			cwd: root,
			timeoutMs: 20_000,
			maxBufferBytes: GIT_DIFF_MAX_CHARS + 16 * 1024,
		});
		if (result.status !== 0) throw new Error(gitFailureMessage(staged ? "git diff --cached" : "git diff", result));
		return result.stdout;
	}

	private async reviewInput(root: string): Promise<string> {
		const staged = await this.trackedDiff(root, true);
		const unstaged = await this.trackedDiff(root, false);
		const untracked = await this.untrackedFiles(root);
		const sections: string[] = [];
		if (staged.trim()) sections.push(`# Staged changes\n\n${staged.trimEnd()}`);
		if (unstaged.trim()) sections.push(`# Working tree changes\n\n${unstaged.trimEnd()}`);
		if (untracked.trim()) sections.push(`# Untracked files\n\n${untracked.trimEnd()}`);
		return capGitInput(sections.join("\n\n"));
	}

	private async untrackedFiles(root: string): Promise<string> {
		const result = await this.runProcess("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
			cwd: root,
			timeoutMs: 10_000,
			maxBufferBytes: GIT_DIFF_MAX_CHARS,
		});
		if (result.status !== 0) throw new Error(gitFailureMessage("git ls-files", result));

		const files = result.stdout.split("\0").filter(Boolean);
		const sections: string[] = [];
		let used = 0;
		for (const file of files) {
			const absolutePath = resolve(root, file);
			const relativePath = relative(root, absolutePath);
			if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) continue;
			const label = displayGitPath(file);
			let body: string;
			try {
				const info = lstatSync(absolutePath);
				if (info.isSymbolicLink()) {
					body = `new symbolic link -> ${readlinkSync(absolutePath)}`;
				} else if (!info.isFile()) {
					body = "non-regular file omitted";
				} else if (statSync(absolutePath).size > UNTRACKED_FILE_MAX_BYTES) {
					body = `file omitted: larger than ${UNTRACKED_FILE_MAX_BYTES} bytes`;
				} else {
					const bytes = readFileSync(absolutePath);
					body = bytes.includes(0)
						? "binary file omitted"
						: bytes.toString("utf8").split(/\r?\n/u).map((line) => `+${line}`).join("\n");
				}
			} catch {
				body = "file became unavailable while collecting review input";
			}
			const section = `## ${label}\n\n--- /dev/null\n+++ b/${label}\n${body}`;
			if (used + section.length > GIT_DIFF_MAX_CHARS) {
				sections.push("[additional untracked files omitted: review input limit reached]");
				break;
			}
			sections.push(section);
			used += section.length;
		}
		return sections.join("\n\n");
	}
}

export async function generateGitAssistantText(
	runtime: AgentSessionRuntime,
	kind: GitAssistantKind,
	diff: string,
): Promise<string> {
	const normalizedDiff = diff.trim();
	if (!normalizedDiff) throw new Error("Git diff is empty");
	const timeoutMs = kind === "review" ? GIT_REVIEW_TIMEOUT_MS : GIT_COMMIT_MESSAGE_TIMEOUT_MS;
	const signal = AbortSignal.timeout(timeoutMs);
	const modelRuntime = runtime.services.modelRuntime;
	await modelRuntime.refresh({ signal });

	let lastError: unknown;
	for (const modelRef of loadGitAssistantModelRefs(runtime.cwd, kind)) {
		if (signal.aborted) throw signal.reason ?? new Error("Git assistant request aborted");
		let parsed: ReturnType<typeof parseModelRef>;
		try {
			parsed = parseModelRef(modelRef);
		} catch (error) {
			lastError = error;
			continue;
		}
		const model = modelRuntime.getModel(parsed.provider, parsed.modelId) as SessionModel | undefined;
		if (!model) {
			lastError = new Error(`Git assistant model not found: ${parsed.provider}/${parsed.modelId}`);
			continue;
		}

		try {
			const tokenLimit = kind === "review" ? GIT_REVIEW_MAX_TOKENS : GIT_COMMIT_MESSAGE_MAX_TOKENS;
			const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, tokenLimit) : tokenLimit;
			let output = "";
			let streamError: string | undefined;
			const stream = modelRuntime.streamSimple(
				{ ...model, maxTokens },
				{
					systemPrompt: kind === "review" ? REVIEW_SYSTEM_PROMPT : COMMIT_MESSAGE_SYSTEM_PROMPT,
					messages: [{
						role: "user",
						content: [
							kind === "review" ? "Review this diff." : "Write a commit message for this staged diff.",
							"<git-diff>",
							normalizedDiff,
							"</git-diff>",
						].join("\n"),
						timestamp: Date.now(),
					}],
				},
				{
					signal,
					reasoning: parsed.thinkingLevel && parsed.thinkingLevel !== "off" ? parsed.thinkingLevel : "minimal",
					cacheRetention: "none",
					maxRetryDelayMs: 0,
					maxRetries: 0,
					maxTokens,
					timeoutMs,
				},
			);
			for await (const event of stream) {
				if (event.type === "text_delta") output += event.delta;
				else if (event.type === "done" && !output) output = assistantText(event.message);
				else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
			}
			if (streamError) throw new Error(streamError);
			const cleaned = cleanupOutput(output);
			if (!cleaned) throw new Error("Git assistant returned an empty response");
			return cleaned;
		} catch (error) {
			if (signal.aborted) throw signal.reason ?? error;
			lastError = error;
		}
	}
	throw lastError ?? new Error("No Git assistant models are configured");
}

export function loadGitAssistantModelRefs(
	cwd: string,
	kind: GitAssistantKind,
	homeDir = homedir(),
): string[] {
	const defaults = kind === "review"
		? { modelRef: DEFAULT_GIT_REVIEW_MODEL, fallbackModels: [] as string[] }
		: { modelRef: DEFAULT_GIT_COMMIT_MESSAGE_MODEL, fallbackModels: [] as string[] };
	const globalConfig = { ...defaults, ...readGitAssistantModelConfig(getPixConfigPath(homeDir), kind) };
	const projectConfig = readGitAssistantModelConfig(getProjectPixConfigPath(cwd), kind);
	const resolved = { ...globalConfig, ...projectConfig };
	return [...new Set([resolved.modelRef, ...resolved.fallbackModels].map((ref) => ref.trim()).filter(Boolean))];
}

function readGitAssistantModelConfig(path: string, kind: GitAssistantKind): { modelRef?: string; fallbackModels?: string[] } {
	if (!existsSync(path)) return {};
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.desktop) || !isRecord(parsed.desktop.git)) return {};
		const git = parsed.desktop.git;
		const modelValue = kind === "review" ? git.reviewModelRef : git.commitMessageModelRef;
		const fallbackKey = kind === "review" ? "reviewFallbackModels" : "commitMessageFallbackModels";
		const modelRef = typeof modelValue === "string" && modelValue.trim() ? modelValue.trim() : undefined;
		const hasFallbackModels = Object.prototype.hasOwnProperty.call(git, fallbackKey);
		return {
			...(modelRef ? { modelRef } : {}),
			...(hasFallbackModels ? { fallbackModels: modelFallbackList(git[fallbackKey]) } : {}),
		};
	} catch {
		return {};
	}
}

function modelFallbackList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))];
}

function capGitInput(value: string): string {
	if (value.length <= GIT_DIFF_MAX_CHARS) return value;
	const marker = "\n\n[Git diff truncated to fit the review input limit]";
	return `${value.slice(0, GIT_DIFF_MAX_CHARS - marker.length)}${marker}`;
}

function cleanupOutput(value: string): string {
	let text = value.replace(/\r\n/gu, "\n").trim();
	const fenced = /^```[^\n`]*\n([\s\S]*?)\n```$/u.exec(text);
	if (fenced) text = fenced[1]!.trim();
	return text;
}

function assistantText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function firstLine(value: string): string {
	return value.trim().split(/\r?\n/u, 1)[0] ?? "Use the generated commit message";
}

function displayGitPath(value: string): string {
	return value.replaceAll("\n", "\\n").replaceAll("\r", "\\r");
}

function gitFailureMessage(command: string, result: AsyncProcessResult): string {
	const detail = result.stderr.trim() || result.stdout.trim() || result.error?.message;
	return detail ? `${command} failed: ${detail}` : `${command} failed`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
