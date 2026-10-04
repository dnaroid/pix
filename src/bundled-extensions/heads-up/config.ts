export interface HeadsUpConfig {
	minTurns: number;
	minIntervalMs: number;
	maxChecksPerHour: number;
	maxInputChars: number;
	maxInputCharsPerHour: number;
	maxTokens: number;
	timeoutMs: number;
	noticeTtlMs: number;
}

export const DEFAULT_HEADS_UP_MODEL = "openai-codex/gpt-6-luna";
export const DEFAULT_HEADS_UP_CONFIG: HeadsUpConfig = {
	minTurns: 6,
	minIntervalMs: 60_000,
	maxChecksPerHour: 12,
	maxInputChars: 16_000,
	maxInputCharsPerHour: 192_000,
	maxTokens: 900,
	timeoutMs: 20_000,
	noticeTtlMs: 5 * 60_000,
};

export const HEADS_UP_CONFIG_LIMITS: Record<keyof HeadsUpConfig, readonly [number, number]> = {
	minTurns: [1, 100],
	minIntervalMs: [0, 24 * 60 * 60_000],
	maxChecksPerHour: [1, 100],
	maxInputChars: [2_000, 50_000],
	maxInputCharsPerHour: [2_000, 1_000_000],
	maxTokens: [256, 2_000],
	timeoutMs: [1_000, 120_000],
	noticeTtlMs: [30_000, 60 * 60_000],
};

/** Merge only known numeric knobs, clamping hostile or accidental values. */
export function normalizeHeadsUpConfig(value: unknown, base: HeadsUpConfig = DEFAULT_HEADS_UP_CONFIG): HeadsUpConfig {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...base };
	const candidate = value as Record<string, unknown>;
	const output = { ...base };
	for (const key of Object.keys(HEADS_UP_CONFIG_LIMITS) as (keyof HeadsUpConfig)[]) {
		const raw = candidate[key];
		if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
		const [min, max] = HEADS_UP_CONFIG_LIMITS[key];
		output[key] = Math.round(Math.min(max, Math.max(min, raw)));
	}
	return output;
}
