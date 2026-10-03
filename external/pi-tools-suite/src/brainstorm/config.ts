export interface BrainstormConfig {
	models: string[];
	thinking: string;
	timeoutSeconds: number;
}

// Explicit council roster, independent of automatic frontier-role selection.
export const DEFAULT_BRAINSTORM_MODELS = [
	"openai-codex/gpt-6-astra",
	"zai/glm-5.3",
	"anthropic/claude-opus-5-5",
	"antigravity/antigravity-gemini-3.8-flash",
] as const;

export function defaultBrainstormConfig(): BrainstormConfig {
	return { models: [...DEFAULT_BRAINSTORM_MODELS], thinking: "high", timeoutSeconds: 600 };
}

export function mergeBrainstormConfig(base: BrainstormConfig, raw: unknown): BrainstormConfig {
	if (raw === undefined) return { ...base, models: [...base.models] };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("brainstorm must be an object.");
	const value = raw as Record<string, unknown>;
	const models = value.models === undefined ? base.models : value.models;
	if (!Array.isArray(models) || models.length < 2 || models.length > 6 ||
		models.some((model) => typeof model !== "string" || !/^[^\s/*?]+\/[^\s*?]+$/.test(model)) ||
		new Set(models).size !== models.length) {
		throw new Error("brainstorm.models must contain 2–6 distinct exact provider/model references (no wildcards).");
	}
	const thinking = value.thinking === undefined ? base.thinking : value.thinking;
	if (typeof thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) {
		throw new Error("Invalid brainstorm.thinking level.");
	}
	const timeoutSeconds = value.timeoutSeconds === undefined ? base.timeoutSeconds : value.timeoutSeconds;
	if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 1800) {
		throw new Error("brainstorm.timeoutSeconds must be an integer from 30 to 1800.");
	}
	return { models: [...models], thinking, timeoutSeconds };
}
