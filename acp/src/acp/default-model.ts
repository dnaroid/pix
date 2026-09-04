import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export type PixThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PixDefaultModel {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: PixThinkingLevel;
}

interface DefaultModelConfig {
	readonly modelRef: string;
	readonly thinking?: PixThinkingLevel;
}

const THINKING_LEVELS = new Set<PixThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

// Mirrors the defaultModel written by src/default-pix-config.ts on a first TUI launch.
const FIRST_LAUNCH_DEFAULT: DefaultModelConfig = {
	modelRef: "openai-codex/gpt-5.6-sol",
	thinking: "medium",
};

/**
 * Resolve the Pix default used for a brand-new session.
 *
 * This mirrors the TUI's config precedence: ~/.config/pi/pix.jsonc first,
 * then <cwd>/.pi/pix.jsonc. A project only replaces the global default when
 * it contains a valid defaultModel value.
 */
export function loadPixDefaultModel(cwd: string, homeDir = homedir()): PixDefaultModel | undefined {
	const globalPath = join(homeDir, ".config", "pi", "pix.jsonc");
	const projectPath = join(cwd, ".pi", "pix.jsonc");

	let configured = existsSync(globalPath)
		? readDefaultModel(globalPath)
		: FIRST_LAUNCH_DEFAULT;
	if (existsSync(projectPath)) configured = readDefaultModel(projectPath) ?? configured;
	return configured ? parseDefaultModel(configured) : undefined;
}

function readDefaultModel(path: string): DefaultModelConfig | undefined {
	try {
		return defaultModelFromParsed(parseJsonc(readFileSync(path, "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

export function defaultModelFromParsed(raw: unknown): DefaultModelConfig | undefined {
	if (!isRecord(raw)) return undefined;
	const configured = raw.defaultModel ?? raw.modelDefault;
	if (typeof configured === "string") return normalizeModelRef(configured);
	if (!isRecord(configured)) return undefined;

	const modelRef = nonEmptyString(configured.modelRef) ?? nonEmptyString(configured.model);
	if (!modelRef) return undefined;
	const normalized = normalizeModelRef(modelRef);
	if (!normalized) return undefined;

	const thinking = normalizeThinking(configured.thinking)
		?? normalizeThinking(configured.thinkingLevel)
		?? normalized.thinking;
	return {
		modelRef: normalized.modelRef,
		...(thinking === undefined ? {} : { thinking }),
	};
}

function normalizeModelRef(value: string): DefaultModelConfig | undefined {
	const modelRef = value.trim();
	if (!modelRef) return undefined;
	const colonIndex = modelRef.lastIndexOf(":");
	if (colonIndex <= 0) return { modelRef };

	const thinking = normalizeThinking(modelRef.slice(colonIndex + 1));
	return thinking
		? { modelRef: modelRef.slice(0, colonIndex), thinking }
		: { modelRef };
}

function parseDefaultModel(config: DefaultModelConfig): PixDefaultModel {
	const [modelRef, suffix] = config.modelRef.split(":", 2);
	const slashIndex = modelRef?.indexOf("/") ?? -1;
	if (!modelRef || slashIndex <= 0 || slashIndex === modelRef.length - 1) {
		throw new Error("Pix default model must use provider/model format");
	}
	if (suffix) throw new Error(`Unknown Pix default model thinking level: ${suffix}`);

	return {
		provider: modelRef.slice(0, slashIndex),
		modelId: modelRef.slice(slashIndex + 1),
		...(config.thinking === undefined ? {} : { thinkingLevel: config.thinking }),
	};
}

function normalizeThinking(value: unknown): PixThinkingLevel | undefined {
	return typeof value === "string" && THINKING_LEVELS.has(value as PixThinkingLevel)
		? value as PixThinkingLevel
		: undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
