import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parse as parseJsonc } from "jsonc-parser";
import { parseModelRef } from "./pix-settings.js";

const GIT_ASSISTANT_TIMEOUT_MS = 45_000;
const GIT_REVIEW_MAX_TOKENS = 4_096;
const GIT_COMMIT_MESSAGE_MAX_TOKENS = 768;
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

export interface GitAssistantInput {
	readonly cwd: string;
	readonly kind: GitAssistantKind;
	readonly diff: string;
	readonly signal: AbortSignal;
}

export type GitAssistant = (input: GitAssistantInput) => Promise<string>;

interface CreateGitAssistantOptions {
	readonly createModelRuntime?: () => Promise<ModelRuntime>;
	readonly loadModelRef?: (cwd: string, kind: GitAssistantKind) => string;
	readonly timeoutMs?: number;
}

export function createGitAssistant(options: CreateGitAssistantOptions = {}): GitAssistant {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const getRuntime = async (signal: AbortSignal): Promise<ModelRuntime> => {
		const pending = runtimePromise ??= (options.createModelRuntime ?? (() => ModelRuntime.create()))();
		try {
			return await raceWithSignal(pending, signal);
		} catch (error) {
			if (runtimePromise === pending) runtimePromise = undefined;
			throw error;
		}
	};

	return async ({ cwd, kind, diff, signal }) => {
		const normalizedDiff = diff.trim();
		if (!normalizedDiff) throw new Error("Git diff is empty");
		const modelRef = (options.loadModelRef ?? loadGitAssistantModelRef)(cwd, kind);
		const parsed = parseModelRef(modelRef);
		if (!parsed) throw new Error(`Invalid Git assistant model: ${modelRef}`);

		const timeoutMs = options.timeoutMs ?? GIT_ASSISTANT_TIMEOUT_MS;
		const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const runtime = await getRuntime(requestSignal);
		let model = runtime.getModel(parsed.provider, parsed.modelId);
		if (!model) {
			await raceWithSignal(runtime.refresh({ signal: requestSignal }), requestSignal);
			model = runtime.getModel(parsed.provider, parsed.modelId);
		}
		if (!model) throw new Error(`Git assistant model not found: ${parsed.provider}/${parsed.modelId}`);

		const tokenLimit = kind === "review" ? GIT_REVIEW_MAX_TOKENS : GIT_COMMIT_MESSAGE_MAX_TOKENS;
		const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, tokenLimit) : tokenLimit;
		const systemPrompt = kind === "review" ? REVIEW_SYSTEM_PROMPT : COMMIT_MESSAGE_SYSTEM_PROMPT;
		let output = "";
		let streamError: string | undefined;
		const stream = runtime.streamSimple(
			{ ...model, maxTokens },
			{
				systemPrompt,
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
				signal: requestSignal,
				...(parsed.thinkingLevel && parsed.thinkingLevel !== "off"
					? { reasoning: parsed.thinkingLevel }
					: { reasoning: "minimal" as const }),
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
	};
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Git assistant request aborted"));
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason ?? new Error("Git assistant request aborted"));
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export function loadGitAssistantModelRef(
	cwd: string,
	kind: GitAssistantKind,
	homeDir = homedir(),
): string {
	const globalPath = join(homeDir, ".config", "pi", "pix.jsonc");
	const projectPath = join(cwd, ".pi", "pix.jsonc");
	const fallback = kind === "review" ? DEFAULT_GIT_REVIEW_MODEL : DEFAULT_GIT_COMMIT_MESSAGE_MODEL;
	const globalModel = readGitAssistantModelRef(globalPath, kind) ?? fallback;
	return readGitAssistantModelRef(projectPath, kind) ?? globalModel;
}

function readGitAssistantModelRef(path: string, kind: GitAssistantKind): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.desktop) || !isRecord(parsed.desktop.git)) return undefined;
		const value = kind === "review"
			? parsed.desktop.git.reviewModelRef
			: parsed.desktop.git.commitMessageModelRef;
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
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
	return content.flatMap((part) =>
		isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
