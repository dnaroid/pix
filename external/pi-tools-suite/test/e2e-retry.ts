export type E2ERetryConfig = {
	maxAttempts: number;
	delayMs: number;
};

export type E2ERetryNotice = E2ERetryConfig & {
	label: string;
	attempt: number;
	error: unknown;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 5_000;

export function isRetryableE2ERateLimit(error: unknown): boolean {
	const text = error instanceof Error
		? `${error.name}: ${error.message}\n${error.stack ?? ""}`
		: String(error);
	return /(?:\b429\b[\s\S]*rate limit|rate limit[\s\S]*\b429\b|rate limit reached for requests)/i.test(text);
}

export function e2eRetryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): E2ERetryConfig {
	return {
		maxAttempts: readPositiveInteger(env.PI_TOOLS_SUITE_E2E_RETRY_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
		delayMs: readNonNegativeInteger(env.PI_TOOLS_SUITE_E2E_RETRY_DELAY_MS, DEFAULT_DELAY_MS),
	};
}

export async function withE2ERetry<T>(
	label: string,
	runAttempt: (attempt: number) => Promise<T>,
	options: Partial<E2ERetryConfig> & { onRetry?: (notice: E2ERetryNotice) => void } = {},
): Promise<T> {
	const defaults = e2eRetryConfigFromEnv();
	const maxAttempts = normalizeInteger(options.maxAttempts, defaults.maxAttempts, 1);
	const delayMs = normalizeInteger(options.delayMs, defaults.delayMs, 0);

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			return await runAttempt(attempt);
		} catch (error) {
			if (attempt >= maxAttempts || !isRetryableE2ERateLimit(error)) throw error;
			options.onRetry?.({ label, attempt, maxAttempts, delayMs, error });
			await sleep(delayMs);
		}
	}

	throw new Error(`unreachable e2e retry state for ${label}`);
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
	return normalizeInteger(value === undefined ? undefined : Number(value), fallback, 1);
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
	return normalizeInteger(value === undefined ? undefined : Number(value), fallback, 0);
}

function normalizeInteger(value: unknown, fallback: number, min: number): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.max(min, Math.floor(numeric));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
