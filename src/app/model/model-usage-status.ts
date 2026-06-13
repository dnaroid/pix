import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatCompactProgressBar } from "../../context-progress-bar.js";
import type { SessionModel } from "../types.js";

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const ZHIPU_QUOTA_URL = "https://bigmodel.cn/api/monitor/usage/quota/limit";
const GOOGLE_QUOTA_API_URL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
const GOOGLE_TOKEN_REFRESH_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ANTIGRAVITY_USER_AGENT = "antigravity/1.11.9 windows/amd64";
const REQUEST_TIMEOUT_MS = 10_000;
const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const PI_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_ANTIGRAVITY_PROJECT_ID = "rising-fact-p41fc";

function getPiAuthPath(): string {
	return process.env.NODE_ENV === "test" && process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
		? process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH
		: PI_AUTH_PATH;
}

const OPENAI_QUOTA_PROVIDERS = new Set(["openai", "openai-codex"]);
const ZHIPU_QUOTA_PROVIDERS = new Set(["zai", "zhipuai-coding-plan"]);
const ANTIGRAVITY_QUOTA_PROVIDERS = new Set(["antigravity", "google-antigravity"]);

type BaseModelUsageDescriptor = {
	readonly modelKey: string;
};

export type ModelUsageDescriptor = BaseModelUsageDescriptor & ({
	readonly kind: "openai" | "zhipu";
} | {
	readonly kind: "google-antigravity";
	readonly quotaModelKey: string;
	readonly account: AntigravityQuotaAccount;
});

export type ModelUsageLimitWindow = {
	readonly remainingPercent: number;
	readonly resetAt: number;
	readonly windowSeconds: number;
};

export type ModelUsageStatus = {
	readonly modelKey: string;
	readonly provider: "openai" | "zhipu" | "google-antigravity";
	readonly updatedAt: number;
	readonly accountEmail?: string;
	readonly weekly?: ModelUsageLimitWindow;
	readonly hourly?: ModelUsageLimitWindow;
};

type OpenAIAuthData = {
	type: string;
	access?: string;
	refresh?: string;
	expires?: number;
	email?: string;
};

type AuthData = {
	openai?: OpenAIAuthData;
	"zai-coding-plan"?: { type: string; key?: string };
	"zhipuai-coding-plan"?: { type: string; key?: string };
};

type PiAuthCredential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	email?: string;
	clientId?: string;
	clientSecret?: string;
	googleClientId?: string;
	googleClientSecret?: string;
	oauthClient?: { clientId?: string; clientSecret?: string };
	accounts?: AntigravityStoredAccount[];
	activeIndex?: number;
};

type PiAuthData = Record<string, PiAuthCredential | undefined>;

type RateLimitWindow = {
	used_percent: number;
	limit_window_seconds: number;
	reset_after_seconds: number;
};

type OpenAIRateLimit = {
	allowed?: boolean;
	limit_reached: boolean;
	primary_window: RateLimitWindow;
	secondary_window: RateLimitWindow | null;
};

type OpenAIAdditionalRateLimit = {
	limit_name: string;
	metered_feature?: string;
	rate_limit: OpenAIRateLimit | null;
};

export type AccountUsageLimitWindow = {
	readonly label: string;
	readonly remainingPercent: number;
	readonly resetAt: number;
	readonly windowSeconds: number;
	readonly used?: number;
	readonly limit?: number;
};

export type AccountUsageReport = {
	readonly openai?: {
		readonly account: string;
		readonly planType?: string;
		readonly windows: readonly AccountUsageLimitWindow[];
		readonly limitReached: boolean;
		readonly additionalLimits?: readonly {
			readonly name: string;
			readonly meteredFeature?: string;
			readonly windows: readonly AccountUsageLimitWindow[];
			readonly limitReached: boolean;
		}[];
		readonly error?: string;
	};
	readonly zai?: {
		readonly account: string;
		readonly windows: readonly AccountUsageLimitWindow[];
		readonly mcp?: AccountUsageLimitWindow;
		readonly error?: string;
	};
	readonly googleAccounts: readonly {
		readonly account: string;
		readonly windows: readonly AccountUsageLimitWindow[];
		readonly limitReached: boolean;
		readonly error?: string;
	}[];
	readonly generatedAt: number;
};

export type OpenAIUsageResponse = {
	plan_type: string;
	rate_limit: OpenAIRateLimit | null;
	additional_rate_limits?: OpenAIAdditionalRateLimit[];
};

type JwtPayload = {
	email?: string;
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
		email?: string;
	};
};

type AntigravityStoredAccount = {
	email?: string;
	refreshToken?: string;
	refresh?: string;
	projectId?: string;
	managedProjectId?: string;
	enabled?: boolean;
	clientId?: string;
	clientSecret?: string;
	googleClientId?: string;
	googleClientSecret?: string;
	oauthClient?: { clientId?: string; clientSecret?: string };
	cachedQuota?: AntigravityCachedQuota;
	cachedQuotaUpdatedAt?: number;
};

type GoogleOAuthClientCredentials = { clientId: string; clientSecret?: string };

type AntigravityCachedQuotaBucket = {
	remainingFraction?: number;
	resetTime?: string;
	modelCount?: number;
};

type AntigravityCachedQuota = Record<string, AntigravityCachedQuotaBucket | undefined>;

type AntigravityQuotaAccount = {
	readonly email?: string;
	readonly refreshToken: string;
	readonly accessToken?: string;
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly cachedQuota?: AntigravityCachedQuota;
	readonly cachedQuotaUpdatedAt?: number;
	readonly projectId: string;
	readonly accountIndex?: number;
	readonly accountCount?: number;
	readonly cacheKey: string;
};

type GoogleQuotaResponse = {
	models: Record<string, {
		quotaInfo?: {
			remainingFraction?: number;
			resetTime?: string;
		};
	}>;
};

export function modelUsageDescriptor(model: SessionModel | undefined): ModelUsageDescriptor | undefined {
	if (!model) return undefined;

	const provider = model.provider.toLowerCase();
	if (OPENAI_QUOTA_PROVIDERS.has(provider)) {
		return { kind: "openai", modelKey: `${model.provider}/${model.id}` };
	}

	if (ZHIPU_QUOTA_PROVIDERS.has(provider)) {
		return { kind: "zhipu", modelKey: `${model.provider}/${model.id}` };
	}

	if (ANTIGRAVITY_QUOTA_PROVIDERS.has(provider)) {
		const quotaModelKey = resolveAntigravityQuotaModelKey(model);
		const account = readActiveAntigravityQuotaAccount();
		if (!quotaModelKey || !account) return undefined;

		return {
			kind: "google-antigravity",
			modelKey: `${model.provider}/${model.id}@${account.cacheKey}`,
			quotaModelKey,
			account,
		};
	}

	return undefined;
}

export async function queryModelUsageStatus(descriptor: ModelUsageDescriptor): Promise<ModelUsageStatus | undefined> {
	switch (descriptor.kind) {
		case "openai":
			return await queryOpenAIModelUsage(descriptor.modelKey);
		case "zhipu":
			return await queryZhipuModelUsage(descriptor.modelKey);
		case "google-antigravity":
			return await queryGoogleAntigravityModelUsage(descriptor);
	}
}

export async function queryAccountUsageReport(now = Date.now()): Promise<AccountUsageReport> {
	const [openai, zai, googleAccounts] = await Promise.all([
		queryOpenAIAccountUsage(now),
		queryZaiAccountUsage(now),
		queryGoogleAntigravityAccountUsage(now),
	]);

	return {
		...(openai ? { openai } : {}),
		...(zai ? { zai } : {}),
		googleAccounts,
		generatedAt: now,
	};
}

export function formatAccountUsageReport(report: AccountUsageReport, now = report.generatedAt): string {
	const lines: string[] = [];

	if (report.openai) {
		lines.push("OpenAI Account Quota", "", `Account:        ${report.openai.account}${report.openai.planType ? ` (${report.openai.planType})` : ""}`, "");
		if (report.openai.error) lines.push(`Unavailable: ${report.openai.error}`);
		else {
			for (const window of report.openai.windows) lines.push(...formatProviderWindow(window, now, 30));
			if (report.openai.limitReached) lines.push("", "⚠️ Rate limit reached!");
			for (const limit of report.openai.additionalLimits ?? []) {
				lines.push(`Additional limit: ${limit.name}`);
				if (limit.meteredFeature) lines.push(`Metered feature:  ${limit.meteredFeature}`);
				lines.push("");
				for (const window of limit.windows) lines.push(...formatProviderWindow(window, now, 30));
				if (limit.limitReached) lines.push("", "⚠️ Rate limit reached!");
			}
		}
		lines.push("");
	}

	if (report.zai) {
		lines.push("Z.ai Account Quota", "", `Account:        ${report.zai.account} (Z.ai)`, "");
		if (report.zai.error) lines.push(`Unavailable: ${report.zai.error}`);
		else {
			for (const window of report.zai.windows) lines.push(...formatProviderWindow(window, now, 30));
			if (report.zai.mcp) {
				lines.push("MCP monthly quota");
				lines.push(`${formatQuotaBar(report.zai.mcp.remainingPercent, 30)} ${report.zai.mcp.remainingPercent}% remaining`);
				if (report.zai.mcp.used !== undefined && report.zai.mcp.limit !== undefined) {
					lines.push(`Used: ${report.zai.mcp.used.toLocaleString()} / ${report.zai.mcp.limit.toLocaleString()}`);
				}
			}
		}
		lines.push("");
	}

	if (report.googleAccounts.length > 0) {
		lines.push("Google Cloud Account Quota", "");
		for (const account of report.googleAccounts) {
			lines.push(account.account, "");
			if (account.error) lines.push(`Unavailable: ${account.error}`);
			else {
				for (const window of account.windows) {
					lines.push(`${window.label.padEnd(14)} ${formatDurationShort(window.resetAt, now).padEnd(7)} ${formatQuotaBar(window.remainingPercent, 20)} ${window.remainingPercent}%`);
				}
				if (account.limitReached) lines.push("", "⚠️ Rate limit reached!");
			}
			lines.push("");
		}
	}

	return lines.join("\n").trimEnd();
}

export function formatModelUsageStatusLabel(status: ModelUsageStatus | undefined, now = Date.now()): string {
	if (!status) return "";

	const parts: string[] = [];
	if (status.hourly) parts.push(formatUsageWindow("H", status.hourly, now));
	if (status.weekly) parts.push(formatUsageWindow("W", status.weekly, now));
	const limitsLabel = parts.join(" • ");
	return status.accountEmail && limitsLabel ? `${status.accountEmail} ${limitsLabel}` : limitsLabel;
}

export function modelUsageRemainingPercent(status: ModelUsageStatus | undefined): number | undefined {
	if (!status) return undefined;

	const values: number[] = [];
	if (status.weekly) values.push(status.weekly.remainingPercent);
	if (status.hourly) values.push(status.hourly.remainingPercent);
	return values.length > 0 ? Math.min(...values) : undefined;
}

export function openAIUsageStatusFromResponse(
	data: OpenAIUsageResponse,
	modelKey: string,
	now = Date.now(),
): ModelUsageStatus | undefined {
	const rateLimit = selectOpenAIRateLimitForModel(data, modelKey);
	if (!rateLimit) return undefined;

	const windows = [rateLimit.primary_window, rateLimit.secondary_window].filter(isRateLimitWindow);
	const weekly = selectWeeklyWindow(windows);
	const hourly = selectHourlyWindow(windows);
	if (!weekly && !hourly) return undefined;

	return {
		modelKey,
		provider: "openai",
		updatedAt: now,
		...(weekly ? { weekly: modelUsageWindow(weekly, now) } : {}),
		...(hourly ? { hourly: modelUsageWindow(hourly, now) } : {}),
	};
}

async function queryOpenAIModelUsage(modelKey: string): Promise<ModelUsageStatus | undefined> {
	const authData = await readOpenAIAuth();
	if (!authData || authData.type !== "oauth" || !authData.access) return undefined;
	if (isExpired(authData)) return undefined;

	const usage = await fetchOpenAIUsage(authData.access);
	return openAIUsageStatusFromResponse(usage, modelKey);
}

async function queryOpenAIAccountUsage(now: number): Promise<AccountUsageReport["openai"] | undefined> {
	const authData = await readOpenAIAuth();
	if (!authData || authData.type !== "oauth" || !authData.access) return undefined;
	if (isExpired(authData)) return {
		account: accountLabelFromOpenAIAuth(authData),
		windows: [],
		limitReached: false,
		error: "OAuth token is expired",
	};

	try {
		const usage = await fetchOpenAIUsage(authData.access);
		const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window]
			.filter(isRateLimitWindow)
			.map((window) => accountWindowFromRateLimit(window, now));
		const additionalLimits = (usage.additional_rate_limits ?? [])
			.filter((limit): limit is OpenAIAdditionalRateLimit & { rate_limit: OpenAIRateLimit } => !!limit.rate_limit)
			.map((limit) => ({
				name: limit.limit_name,
				...(limit.metered_feature ? { meteredFeature: limit.metered_feature } : {}),
				windows: [limit.rate_limit.primary_window, limit.rate_limit.secondary_window]
					.filter(isRateLimitWindow)
					.map((window) => accountWindowFromRateLimit(window, now)),
				limitReached: limit.rate_limit.limit_reached === true,
			}));

		return {
			account: accountLabelFromOpenAIAuth(authData),
			...(usage.plan_type ? { planType: usage.plan_type } : {}),
			windows,
			limitReached: usage.rate_limit?.limit_reached === true,
			...(additionalLimits.length > 0 ? { additionalLimits } : {}),
		};
	} catch (error) {
		return {
			account: accountLabelFromOpenAIAuth(authData),
			windows: [],
			limitReached: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function readOpenAIAuth(): Promise<OpenAIAuthData | undefined> {
	const authData = await readOpenCodeAuth();
	const piAuth = await readPiAuth();

	const piOpenAI = piAuth["openai-codex"];
	if ((!authData.openai || isExpired(authData.openai)) && piOpenAI?.type === "oauth" && piOpenAI.access) {
		const credential: OpenAIAuthData = {
			type: "oauth",
			access: piOpenAI.access,
		};
		if (piOpenAI.refresh) credential.refresh = piOpenAI.refresh;
		if (typeof piOpenAI.expires === "number") credential.expires = piOpenAI.expires;
		if (piOpenAI.email) credential.email = piOpenAI.email;
		authData.openai = credential;
	}

	return authData.openai;
}

function accountLabelFromOpenAIAuth(authData: OpenAIAuthData): string {
	return authData.email || (authData.access ? openAIAccountEmailFromJwt(authData.access) : undefined) || "OpenAI";
}

async function readOpenCodeAuth(): Promise<AuthData> {
	try {
		const content = await readFile(join(homedir(), ".local/share/opencode/auth.json"), "utf8");
		return JSON.parse(content) as AuthData;
	} catch {
		return {};
	}
}

async function readPiAuth(): Promise<PiAuthData> {
	try {
		const content = await readFile(getPiAuthPath(), "utf8");
		return JSON.parse(content) as PiAuthData;
	} catch {
		return {};
	}
}

function isExpired(credential: { expires?: number } | undefined): boolean {
	return typeof credential?.expires === "number" && credential.expires < Date.now();
}

// ---------------------------------------------------------------------------
// Zhipu / Z.ai quota
// ---------------------------------------------------------------------------

type ZhipuUsageLimitItem = {
	type: string;
	usage: number;
	currentValue: number;
	percentage: number;
	nextResetTime?: number;
};

type ZhipuQuotaResponse = {
	code: number;
	msg: string;
	data: { limits: ZhipuUsageLimitItem[] };
	success: boolean;
};

export function zhipuUsageStatusFromResponse(
	data: ZhipuQuotaResponse,
	modelKey: string,
	now = Date.now(),
): ModelUsageStatus | undefined {
	if (!data.success || data.code !== 200) return undefined;

	const tokensLimit = data.data.limits.find((l) => l.type === "TOKENS_LIMIT");
	if (!tokensLimit) return undefined;

	const remainingPercent = clampPercent(100 - Math.round(tokensLimit.percentage));
	const resetAt = typeof tokensLimit.nextResetTime === "number" && tokensLimit.nextResetTime > now
		? tokensLimit.nextResetTime
		: now + 5 * HOUR_SECONDS * 1000;

	return {
		modelKey,
		provider: "zhipu",
		updatedAt: now,
		hourly: {
			remainingPercent,
			resetAt,
			windowSeconds: 5 * HOUR_SECONDS,
		},
	};
}

async function queryZhipuModelUsage(modelKey: string): Promise<ModelUsageStatus | undefined> {
	const apiKey = await readZhipuApiKey();
	if (!apiKey) return undefined;

	const response = await fetchZhipuQuota(apiKey, modelKey.startsWith("zhipuai") ? ZHIPU_QUOTA_URL : ZAI_QUOTA_URL);
	return zhipuUsageStatusFromResponse(response, modelKey);
}

async function queryZaiAccountUsage(now: number): Promise<AccountUsageReport["zai"] | undefined> {
	const apiKey = await readZhipuApiKey();
	if (!apiKey) return undefined;

	try {
		const response = await fetchZhipuQuota(apiKey, ZAI_QUOTA_URL);
		if (!response.success || response.code !== 200) {
			return { account: maskCredential(apiKey), windows: [], error: response.msg || "quota request failed" };
		}

		const tokenLimits = response.data.limits
			.filter((limit) => limit.type === "TOKENS_LIMIT")
			.map((limit) => ({
				label: "5-hour token limit",
				remainingPercent: clampPercent(100 - Math.round(limit.percentage)),
				resetAt: typeof limit.nextResetTime === "number" && limit.nextResetTime > now ? limit.nextResetTime : now + 5 * HOUR_SECONDS * 1000,
				windowSeconds: 5 * HOUR_SECONDS,
			}));
		const mcpLimit = response.data.limits.find((limit) => /MCP/iu.test(limit.type));

		return {
			account: maskCredential(apiKey),
			windows: tokenLimits,
			...(mcpLimit ? {
				mcp: {
					label: "MCP monthly quota",
					remainingPercent: clampPercent(100 - Math.round(mcpLimit.percentage)),
					resetAt: typeof mcpLimit.nextResetTime === "number" && mcpLimit.nextResetTime > now ? mcpLimit.nextResetTime : now,
					windowSeconds: 30 * DAY_SECONDS,
					used: mcpLimit.usage,
					limit: mcpLimit.currentValue,
				},
			} : {}),
		};
	} catch (error) {
		return {
			account: maskCredential(apiKey),
			windows: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function readZhipuApiKey(): Promise<string | undefined> {
	const piAuth = await readPiAuth();

	const zaiCredential = piAuth.zai;
	if (zaiCredential?.key && (zaiCredential.type === "api" || zaiCredential.type === "api_key")) {
		return zaiCredential.key;
	}

	const opencodeAuth = await readOpenCodeAuth();
	const zaiPlan = opencodeAuth["zai-coding-plan"];
	if (zaiPlan?.key) return zaiPlan.key;

	const zhipuPlan = opencodeAuth["zhipuai-coding-plan"];
	if (zhipuPlan?.key) return zhipuPlan.key;

	return undefined;
}

async function fetchZhipuQuota(apiKey: string, url: string): Promise<ZhipuQuotaResponse> {
	const response = await fetchWithTimeout(url, {
		headers: {
			Authorization: apiKey,
			"Content-Type": "application/json",
			"User-Agent": "pi-ui-extend/0.1.0",
		},
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Zhipu quota request failed (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<ZhipuQuotaResponse>;
}

// ---------------------------------------------------------------------------
// Google Antigravity quota
// ---------------------------------------------------------------------------

export function resolveAntigravityQuotaModelKey(model: SessionModel): string | undefined {
	const source = `${model.id} ${model.name ?? ""}`.toLowerCase();
	const normalized = source.replace(/[_\s]+/gu, "-");

	if (normalized.includes("claude") && normalized.includes("opus") && normalized.includes("thinking")) {
		return "claude-opus-4-6-thinking";
	}
	if (normalized.includes("claude") && normalized.includes("sonnet")) return "claude-sonnet-4-6";
	if (normalized.includes("gemini-2.5-flash") || /\bg2[.-]?5-flash\b/u.test(normalized)) return "gemini-2.5-flash";
	if (normalized.includes("gemini-3-flash") || /\bg3-flash\b/u.test(normalized)) return "gemini-3-flash";
	if (normalized.includes("gemini-3") && normalized.includes("flash")) return "gemini-3-flash";
	if (normalized.includes("gemini-3") && normalized.includes("pro")) return "gemini-3.1-pro-low";
	if (/\bg3(?:-pro)?\b/u.test(normalized)) return "gemini-3.1-pro-low";

	return undefined;
}

export function googleAntigravityUsageStatusFromResponse(
	data: GoogleQuotaResponse,
	descriptor: Extract<ModelUsageDescriptor, { kind: "google-antigravity" }>,
	now = Date.now(),
): ModelUsageStatus | undefined {
	const quotaInfo = data.models[descriptor.quotaModelKey]?.quotaInfo;
	if (!quotaInfo) return undefined;

	const resetAt = parseResetTime(quotaInfo.resetTime, now);
	const window = {
		remainingPercent: quotaRemainingPercent(quotaInfo),
		resetAt,
		windowSeconds: Math.max(0, Math.round((resetAt - now) / 1000)),
	};
	const weekly = window.windowSeconds >= DAY_SECONDS ? window : undefined;
	const hourly = weekly ? undefined : window;

	return {
		modelKey: descriptor.modelKey,
		provider: "google-antigravity",
		updatedAt: now,
		...(descriptor.account.email ? { accountEmail: descriptor.account.email } : {}),
		...(weekly ? { weekly } : {}),
		...(hourly ? { hourly } : {}),
	};
}

async function queryGoogleAntigravityModelUsage(
	descriptor: Extract<ModelUsageDescriptor, { kind: "google-antigravity" }>,
): Promise<ModelUsageStatus | undefined> {
	const now = Date.now();
	const response = await fetchGoogleAntigravityQuotaForAccount(descriptor.account, now);
	return googleAntigravityUsageStatusFromResponse(response, descriptor, now);
}

const GOOGLE_ACCOUNT_QUOTA_WINDOWS = [
	{ label: "Claude Opus", quotaModelKey: "claude-opus-4-6-thinking" },
	{ label: "Claude Sonnet", quotaModelKey: "claude-sonnet-4-6" },
	{ label: "G2.5 Flash", quotaModelKey: "gemini-2.5-flash" },
	{ label: "G3 Flash", quotaModelKey: "gemini-3-flash" },
	{ label: "G3 Pro", quotaModelKey: "gemini-3.1-pro-low" },
] as const;

async function queryGoogleAntigravityAccountUsage(now: number): Promise<AccountUsageReport["googleAccounts"]> {
	const accounts = readAllAntigravityQuotaAccounts();
	const results = await Promise.all(accounts.map(async (account) => {
		const accountLabel = account.email ?? maskCredential(account.refreshToken);
		try {
			const response = await fetchGoogleAntigravityQuotaForAccount(account, now);
			const windows = googleAccountWindowsFromResponse(response, now);

			return {
				account: accountLabel,
				windows,
				limitReached: windows.some((window) => window.remainingPercent <= 0),
			};
		} catch (error) {
			return {
				account: accountLabel,
				windows: [],
				limitReached: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}));

	return results;
}

function readActiveAntigravityQuotaAccount(): AntigravityQuotaAccount | undefined {
	const accounts = readAllAntigravityQuotaAccounts();
	const credential = readPiAuthSync().antigravity;
	return accounts[clampAccountIndex(credential?.activeIndex, accounts.length)];
}

function readAllAntigravityQuotaAccounts(): AntigravityQuotaAccount[] {
	const credential = readPiAuthSync().antigravity;
	if (!credential) return [];
	const credentialClient = getGoogleOAuthClientCredentials(credential);

	const accounts = storedAntigravityAccounts(credential);
	if (accounts.length > 0) {
		const activeIndex = clampAccountIndex(credential.activeIndex, accounts.length);
		const activeAccess = antigravityAccessFromCredential(credential);
		return accounts.map((account, accountIndex) => antigravityQuotaAccount(account, {
			...(credential.email ? { fallbackEmail: credential.email } : {}),
			...(credentialClient ? { clientCredentials: credentialClient } : {}),
			...(accountIndex === activeIndex && activeAccess ? { accessToken: activeAccess.accessToken } : {}),
			accountIndex,
			accountCount: accounts.length,
		})).filter((account): account is AntigravityQuotaAccount => account !== undefined);
	}

	const fallbackAccount = antigravityAccountFromCredential(credential);
	const fallbackAccess = antigravityAccessFromCredential(credential);
	const account = fallbackAccount ? antigravityQuotaAccount(fallbackAccount, {
		...(credential.email ? { fallbackEmail: credential.email } : {}),
		...(credentialClient ? { clientCredentials: credentialClient } : {}),
		...(fallbackAccess ? { accessToken: fallbackAccess.accessToken } : {}),
	}) : undefined;
	return account ? [account] : [];
}

function readPiAuthSync(): PiAuthData {
	try {
		return JSON.parse(readFileSync(getPiAuthPath(), "utf8")) as PiAuthData;
	} catch {
		return {};
	}
}

function getAccountRefreshToken(account: AntigravityStoredAccount): string | undefined {
	if (account.refreshToken) return account.refreshToken;
	if (!account.refresh) return undefined;
	return splitAntigravityRefresh(account.refresh).refreshToken;
}

function stringProperty(source: unknown, keys: string[]): string | undefined {
	if (!source || typeof source !== "object") return undefined;
	const record = source as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

function getGoogleOAuthClientCredentials(...sources: unknown[]): GoogleOAuthClientCredentials | undefined {
	for (const source of sources) {
		const nested = source && typeof source === "object"
			? (source as Record<string, unknown>).oauthClient
			: undefined;
		const nestedClientId = stringProperty(nested, ["clientId", "client_id", "id"]);
		const nestedClientSecret = stringProperty(nested, ["clientSecret", "client_secret", "secret"]);
		const clientId = nestedClientId ?? stringProperty(source, ["clientId", "client_id", "googleClientId", "google_client_id", "oauthClientId", "oauth_client_id"]);
		const clientSecret = nestedClientSecret ?? stringProperty(source, ["clientSecret", "client_secret", "googleClientSecret", "google_client_secret", "oauthClientSecret", "oauth_client_secret"]);
		if (clientId) return { clientId, ...(clientSecret ? { clientSecret } : {}) };
	}
	return undefined;
}

function storedAntigravityAccounts(credential: PiAuthCredential): AntigravityStoredAccount[] {
	return Array.isArray(credential.accounts)
		? credential.accounts.filter((account) => account.enabled !== false && !!getAccountRefreshToken(account))
		: [];
}

function antigravityAccountFromCredential(credential: PiAuthCredential): AntigravityStoredAccount | undefined {
	if (credential.type !== "oauth" || !credential.refresh) return undefined;
	const refresh = splitAntigravityRefresh(credential.refresh);
	if (!refresh.refreshToken) return undefined;
	const activeStoredAccount = credential.accounts?.[clampAccountIndex(credential.activeIndex, credential.accounts.length)];
	return {
		refreshToken: refresh.refreshToken,
		projectId: refresh.projectId || refresh.managedProjectId || DEFAULT_ANTIGRAVITY_PROJECT_ID,
		enabled: true,
		...(credential.email ? { email: credential.email } : {}),
		...(refresh.managedProjectId ? { managedProjectId: refresh.managedProjectId } : {}),
		...(activeStoredAccount?.cachedQuota ? { cachedQuota: activeStoredAccount.cachedQuota } : {}),
		...(typeof activeStoredAccount?.cachedQuotaUpdatedAt === "number" ? { cachedQuotaUpdatedAt: activeStoredAccount.cachedQuotaUpdatedAt } : {}),
	};
}

function antigravityQuotaAccount(
	account: AntigravityStoredAccount,
	options: { fallbackEmail?: string; accessToken?: string; clientCredentials?: GoogleOAuthClientCredentials; accountIndex?: number; accountCount?: number } = {},
): AntigravityQuotaAccount | undefined {
	const refreshToken = getAccountRefreshToken(account);
	if (!refreshToken) return undefined;
	const email = account.email || options.fallbackEmail;
	const projectId = account.projectId || account.managedProjectId || DEFAULT_ANTIGRAVITY_PROJECT_ID;
	const clientCredentials = getGoogleOAuthClientCredentials(account, options.clientCredentials);
	return {
		refreshToken,
		projectId,
		cacheKey: email ? email.toLowerCase() : shortHash(refreshToken),
		...(options.accessToken ? { accessToken: options.accessToken } : {}),
		...(clientCredentials ? { clientId: clientCredentials.clientId } : {}),
		...(clientCredentials?.clientSecret ? { clientSecret: clientCredentials.clientSecret } : {}),
		...(account.cachedQuota ? { cachedQuota: account.cachedQuota } : {}),
		...(typeof account.cachedQuotaUpdatedAt === "number" ? { cachedQuotaUpdatedAt: account.cachedQuotaUpdatedAt } : {}),
		...(email ? { email } : {}),
		...(typeof options.accountIndex === "number" ? { accountIndex: options.accountIndex } : {}),
		...(typeof options.accountCount === "number" ? { accountCount: options.accountCount } : {}),
	};
}

function googleQuotaResponseFromCachedQuota(
	cachedQuota: AntigravityCachedQuota | undefined,
	cachedQuotaUpdatedAt?: number,
	now = Date.now(),
): GoogleQuotaResponse | undefined {
	if (!cachedQuota) return undefined;
	const models: GoogleQuotaResponse["models"] = {};
	addCachedQuotaModels(models, cachedQuota.claude, ["claude-opus-4-6-thinking", "claude-sonnet-4-6"], cachedQuotaUpdatedAt, now);
	addCachedQuotaModels(models, cachedQuota["gemini-flash"], ["gemini-2.5-flash", "gemini-3-flash"], cachedQuotaUpdatedAt, now);
	addCachedQuotaModels(models, cachedQuota["gemini-pro"], ["gemini-3.1-pro-low"], cachedQuotaUpdatedAt, now);
	return Object.keys(models).length > 0 ? { models } : undefined;
}

function addCachedQuotaModels(
	models: GoogleQuotaResponse["models"],
	quota: AntigravityCachedQuotaBucket | undefined,
	quotaModelKeys: readonly string[],
	cachedQuotaUpdatedAt: number | undefined,
	now: number,
): void {
	if (!quota || !Number.isFinite(quota.remainingFraction)) return;
	const remainingFraction = quota.remainingFraction as number;
	const resetTime = cachedQuotaResetTimeForDisplay(quota.resetTime, cachedQuotaUpdatedAt, now);
	for (const quotaModelKey of quotaModelKeys) {
		models[quotaModelKey] = {
			quotaInfo: {
				remainingFraction,
				...(resetTime ? { resetTime } : {}),
			},
		};
	}
}

function cachedQuotaResetTimeForDisplay(resetTime: string | undefined, cachedQuotaUpdatedAt: number | undefined, now: number): string | undefined {
	if (!resetTime) return undefined;
	const resetAt = Date.parse(resetTime);
	if (!Number.isFinite(resetAt) || resetAt > now) return resetTime;

	const cachedAt = normalizeTimestampMillis(cachedQuotaUpdatedAt);
	if (!Number.isFinite(cachedAt) || resetAt <= cachedAt) return resetTime;

	return new Date(now + (resetAt - cachedAt)).toISOString();
}

function normalizeTimestampMillis(value: number | undefined): number {
	if (!Number.isFinite(value)) return Number.NaN;
	const timestamp = value as number;
	return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function antigravityAccessFromCredential(credential: PiAuthCredential): { accessToken: string; projectId?: string } | undefined {
	if (credential.type !== "oauth" || !credential.access || isExpired(credential)) return undefined;
	const [accessToken = "", projectId = ""] = credential.access.split("|");
	if (!accessToken) return undefined;
	return {
		accessToken,
		...(projectId ? { projectId } : {}),
	};
}

function splitAntigravityRefresh(refresh: string): { refreshToken: string; projectId?: string; managedProjectId?: string } {
	const [refreshToken = "", projectId = "", managedProjectId = ""] = refresh.split("|");
	return {
		refreshToken: refreshToken || refresh,
		...(projectId ? { projectId } : {}),
		...(managedProjectId ? { managedProjectId } : {}),
	};
}

function clampAccountIndex(index: unknown, accountCount: number): number {
	if (!Number.isInteger(index) || accountCount <= 0) return 0;
	return Math.max(0, Math.min(index as number, accountCount - 1));
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function fetchGoogleAntigravityQuotaForAccount(account: AntigravityQuotaAccount, now = Date.now()): Promise<GoogleQuotaResponse> {
	if (account.accessToken) return await fetchGoogleAntigravityQuota(account.accessToken, account.projectId);

	if (account.clientId) {
		const { accessToken } = await refreshGoogleAntigravityAccessToken(account);
		return await fetchGoogleAntigravityQuota(accessToken, account.projectId);
	}

	const cachedResponse = googleQuotaResponseFromCachedQuota(account.cachedQuota, account.cachedQuotaUpdatedAt, now);
	if (cachedResponse) return cachedResponse;

	throw new Error("Missing Google OAuth client credentials, cannot query live Antigravity quota.");
}

async function refreshGoogleAntigravityAccessToken(account: AntigravityQuotaAccount): Promise<{ accessToken: string }> {
	if (!account.clientId) throw new Error("Missing Google OAuth client id, cannot refresh Antigravity access token.");

	const params = new URLSearchParams({
		client_id: account.clientId,
		refresh_token: account.refreshToken,
		grant_type: "refresh_token",
	});
	if (account.clientSecret) params.set("client_secret", account.clientSecret);

	const response = await fetchWithTimeout(GOOGLE_TOKEN_REFRESH_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params,
	});
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Google token refresh failed (${response.status}): ${errorText}`);
	}

	const data = await response.json() as { access_token?: string };
	if (!data.access_token) throw new Error("Google token refresh did not return an access token.");
	return { accessToken: data.access_token };
}

async function fetchGoogleAntigravityQuota(accessToken: string, projectId: string): Promise<GoogleQuotaResponse> {
	const response = await fetchWithTimeout(GOOGLE_QUOTA_API_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": GOOGLE_ANTIGRAVITY_USER_AGENT,
		},
		body: JSON.stringify({ project: projectId }),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Google quota request failed (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<GoogleQuotaResponse>;
}

function parseResetTime(value: string | undefined, now: number): number {
	if (!value) return now;
	const resetAt = Date.parse(value);
	return Number.isFinite(resetAt) && resetAt > now ? resetAt : now;
}

async function fetchOpenAIUsage(accessToken: string): Promise<OpenAIUsageResponse> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": "pi-ui-extend/0.1.0",
	};

	const accountId = getAccountIdFromJwt(accessToken);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;

	const response = await fetchWithTimeout(OPENAI_USAGE_URL, { headers });
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI usage request failed (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<OpenAIUsageResponse>;
}

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`Request timeout (${Math.round(REQUEST_TIMEOUT_MS / 1000)}s)`);
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

function getAccountIdFromJwt(token: string): string | undefined {
	const payload = parseJwt(token);
	return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
}

function openAIAccountEmailFromJwt(token: string): string | undefined {
	const payload = parseJwt(token);
	return payload?.email || payload?.["https://api.openai.com/auth"]?.email;
}

function parseJwt(token: string): JwtPayload | undefined {
	try {
		const parts = token.split(".");
		const payloadPart = parts[1];
		if (parts.length !== 3 || !payloadPart) return undefined;
		const payloadJson = base64UrlDecode(payloadPart);
		return JSON.parse(payloadJson) as JwtPayload;
	} catch {
		return undefined;
	}
}

function base64UrlDecode(input: string): string {
	const base64 = input.replace(/-/gu, "+").replace(/_/gu, "/");
	const padLength = (4 - (base64.length % 4)) % 4;
	return Buffer.from(`${base64}${"=".repeat(padLength)}`, "base64").toString("utf8");
}

function isRateLimitWindow(value: RateLimitWindow | null | undefined): value is RateLimitWindow {
	return value !== null && value !== undefined
		&& Number.isFinite(value.used_percent)
		&& Number.isFinite(value.limit_window_seconds)
		&& Number.isFinite(value.reset_after_seconds);
}

function selectOpenAIRateLimitForModel(data: OpenAIUsageResponse, modelKey: string): OpenAIRateLimit | null {
	const additionalLimit = (data.additional_rate_limits ?? []).find((limit) => {
		if (!limit.rate_limit) return false;
		return openAIModelMatchesAdditionalLimit(modelKey, limit);
	});

	// Prefer exact named per-model buckets when the API exposes them, but keep the
	// top-level bucket as a fallback. Some Codex responses currently expose a
	// usable selected-model/account bucket only at the top level while also
	// listing unrelated named additional buckets; hiding the fallback makes the
	// status bar disappear completely for those models.
	return additionalLimit?.rate_limit ?? data.rate_limit;
}

function openAIModelMatchesAdditionalLimit(modelKey: string, limit: OpenAIAdditionalRateLimit): boolean {
	const modelId = modelKey.split("/").at(-1) ?? modelKey;
	return openAIModelIdMatchesLimitCandidate(modelId, limit.limit_name)
		|| (limit.metered_feature ? openAIModelIdMatchesLimitCandidate(modelId, limit.metered_feature) : false);
}

function openAIModelIdMatchesLimitCandidate(modelId: string, candidate: string): boolean {
	const modelTokens = openAILimitTokens(modelId);
	const candidateTokens = openAILimitTokens(candidate);
	if (modelTokens.length === 0 || candidateTokens.length === 0) return false;
	if (containsTokenSequence(candidateTokens, modelTokens)) return true;

	// Support compact names such as o4mini while avoiding prefix matches such as
	// gpt-5 accidentally matching gpt-5.5.
	return normalizeOpenAILimitName(candidate) === normalizeOpenAILimitName(modelId);
}

function normalizeOpenAILimitName(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function openAILimitTokens(value: string): string[] {
	return value.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 0);
}

function containsTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
	if (sequence.length > tokens.length) return false;
	for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
		let matches = true;
		for (let offset = 0; offset < sequence.length; offset += 1) {
			if (tokens[start + offset] !== sequence[offset]) {
				matches = false;
				break;
			}
		}
		if (matches) return true;
	}
	return false;
}

function selectWeeklyWindow(windows: readonly RateLimitWindow[]): RateLimitWindow | undefined {
	return windows
		.filter((window) => window.limit_window_seconds >= 6 * DAY_SECONDS)
		.sort((a, b) => b.limit_window_seconds - a.limit_window_seconds)[0];
}

function selectHourlyWindow(windows: readonly RateLimitWindow[]): RateLimitWindow | undefined {
	return windows
		.filter((window) => window.limit_window_seconds <= 6 * HOUR_SECONDS)
		.sort((a, b) => a.limit_window_seconds - b.limit_window_seconds)[0];
}

function modelUsageWindow(window: RateLimitWindow, now: number): ModelUsageLimitWindow {
	return {
		remainingPercent: clampPercent(Math.round(100 - window.used_percent)),
		resetAt: now + Math.max(0, Math.round(window.reset_after_seconds)) * 1000,
		windowSeconds: Math.max(0, Math.round(window.limit_window_seconds)),
	};
}

function accountWindowFromRateLimit(window: RateLimitWindow, now: number): AccountUsageLimitWindow {
	const windowSeconds = Math.max(0, Math.round(window.limit_window_seconds));
	return {
		label: accountWindowLabel(windowSeconds),
		remainingPercent: clampPercent(Math.round(100 - window.used_percent)),
		resetAt: now + Math.max(0, Math.round(window.reset_after_seconds)) * 1000,
		windowSeconds,
	};
}

function googleAccountWindowFromResponse(
	data: GoogleQuotaResponse,
	label: string,
	quotaModelKey: string,
	now: number,
): AccountUsageLimitWindow | undefined {
	const quotaInfo = data.models[quotaModelKey]?.quotaInfo;
	if (!quotaInfo) return undefined;
	const resetAt = parseResetTime(quotaInfo.resetTime, now);
	return {
		label,
		remainingPercent: quotaRemainingPercent(quotaInfo),
		resetAt,
		windowSeconds: Math.max(0, Math.round((resetAt - now) / 1000)),
	};
}

function quotaRemainingPercent(quotaInfo: { remainingFraction?: number }): number {
	return clampPercent(Math.round((Number.isFinite(quotaInfo.remainingFraction) ? quotaInfo.remainingFraction as number : 0) * 100));
}

function googleAccountWindowsFromResponse(data: GoogleQuotaResponse, now: number): AccountUsageLimitWindow[] {
	return GOOGLE_ACCOUNT_QUOTA_WINDOWS
		.map((window) => googleAccountWindowFromResponse(data, window.label, window.quotaModelKey, now))
		.filter((window): window is AccountUsageLimitWindow => window !== undefined);
}

function clampPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
}

function accountWindowLabel(windowSeconds: number): string {
	if (windowSeconds >= 6 * DAY_SECONDS) return `${Math.round(windowSeconds / DAY_SECONDS)}-day limit`;
	if (windowSeconds >= HOUR_SECONDS) return `${Math.round(windowSeconds / HOUR_SECONDS)}-hour limit`;
	return `${Math.max(1, Math.round(windowSeconds / 60))}-minute limit`;
}

function formatProviderWindow(window: AccountUsageLimitWindow, now: number, width: number): string[] {
	return [
		window.label,
		`${formatQuotaBar(window.remainingPercent, width)} ${window.remainingPercent}% remaining`,
		`Resets in: ${formatDurationLong(window.resetAt, now)}`,
		"",
	];
}

function formatQuotaBar(percent: number, width: number): string {
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatDurationLong(resetAt: number, now: number): string {
	if (resetAt <= now) return "reset";
	const totalMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatDurationShort(resetAt: number, now: number): string {
	if (resetAt <= now) return "reset";
	const totalMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}

function maskCredential(value: string): string {
	const visible = value.trim();
	if (visible.length <= 8) return visible ? "****" : "unknown";
	return `${visible.slice(0, 4)}****${visible.slice(-4)}`;
}

function formatUsageWindow(_prefix: "W" | "H", window: ModelUsageLimitWindow, now: number): string {
	return `${window.remainingPercent}% ${formatCompactProgressBar(window.remainingPercent)} ${formatDurationShort(window.resetAt, now)}`;
}
