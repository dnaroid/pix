import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	formatAccountUsageReport,
	formatModelUsageStatusLabel,
	googleAntigravityUsageStatusFromResponse,
	modelUsageDescriptor,
	modelUsageRemainingPercent,
	openAIUsageStatusFromResponse,
	queryAccountUsageReport,
	resolveAntigravityQuotaModelKey,
	type AccountUsageReport,
	zhipuUsageStatusFromResponse,
	type ModelUsageDescriptor,
	type OpenAIUsageResponse,
} from "../src/app/model/model-usage-status.js";
import type { SessionModel } from "../src/app/types.js";

describe("model usage status", () => {
	it("builds descriptors for OpenAI quota-backed models only", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "openai-codex", id: "gpt-5.5" } as SessionModel), {
			kind: "openai",
			modelKey: "openai-codex/gpt-5.5",
		});
		assert.equal(modelUsageDescriptor({ provider: "anthropic", id: "claude" } as SessionModel), undefined);
	});

	it("builds descriptors for Zhipu/Z.ai quota-backed models", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "zai", id: "glm-5.1" } as SessionModel), {
			kind: "zhipu",
			modelKey: "zai/glm-5.1",
		});
		assert.deepEqual(modelUsageDescriptor({ provider: "zhipuai-coding-plan", id: "glm-4" } as SessionModel), {
			kind: "zhipu",
			modelKey: "zhipuai-coding-plan/glm-4",
		});
	});

	it("builds Antigravity descriptors from the currently rotated account", () => {
		withPiAuth({
			antigravity: {
				type: "oauth",
				email: "fallback@example.com",
				accounts: [
					{ email: "first@example.com", refreshToken: "refresh-1", projectId: "project-1", enabled: true },
					{ email: "second@example.com", refreshToken: "refresh-2", projectId: "project-2", enabled: true },
				],
				activeIndex: 1,
			},
		}, () => {
			const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "G3" } as SessionModel);

			assert.equal(descriptor?.kind, "google-antigravity");
			assert.equal(descriptor?.modelKey, "antigravity/G3@second@example.com");
			if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");
			assert.equal(descriptor.quotaModelKey, "gemini-3.1-pro-low");
			assert.equal(descriptor.account.email, "second@example.com");
			assert.equal(descriptor.account.projectId, "project-2");
			assert.equal(descriptor.account.accountIndex, 1);
			assert.equal(descriptor.account.accountCount, 2);
		});
	});

	it("maps Antigravity model aliases to Google quota buckets", () => {
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "G3" } as SessionModel), "gemini-3.1-pro-low");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "G3 Flash" } as SessionModel), "gemini-3-flash");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "gemini-2.5-flash" } as SessionModel), "gemini-2.5-flash");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-claude-opus-4-6-thinking" } as SessionModel), "claude-opus-4-6-thinking");
	});

	it("extracts weekly and hourly OpenAI windows for the status bar", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "plus",
			rate_limit: {
				limit_reached: false,
				primary_window: {
					used_percent: 12.4,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_after_seconds: 5 * 24 * 60 * 60,
				},
				secondary_window: {
					used_percent: 55,
					limit_window_seconds: 60 * 60,
					reset_after_seconds: 31 * 60,
				},
			},
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(status?.weekly?.remainingPercent, 88);
		assert.equal(status?.hourly?.remainingPercent, 45);
		assert.equal(modelUsageRemainingPercent(status), 45);
		assert.equal(formatModelUsageStatusLabel(status, now), `45% ██▎   ${formatExpectedResetDuration(now + 31 * 60 * 1000, now)} • 88% ████▍ ${formatExpectedResetDuration(now + 5 * 24 * 60 * 60 * 1000, now)}`);
	});

	it("formats global resets within one day as a clock time", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "plus",
			rate_limit: {
				limit_reached: false,
				primary_window: {
					used_percent: 12.4,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_after_seconds: 14 * 60 * 60,
				},
				secondary_window: null,
			},
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(status?.weekly?.remainingPercent, 88);
		assert.equal(formatModelUsageStatusLabel(status, now), `88% ████▍ ${formatExpectedResetDuration(now + 14 * 60 * 60 * 1000, now)}`);
	});

	it("uses matching OpenAI additional model limits for the status bar", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "prolite",
			rate_limit: {
				limit_reached: false,
				primary_window: { used_percent: 25, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 2 * 60 * 60 },
				secondary_window: { used_percent: 20, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
			},
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 1, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 42 * 60 },
					secondary_window: { used_percent: 0, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
				},
			}],
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.3-codex-spark", now);

		assert.equal(status?.hourly?.remainingPercent, 99);
		assert.equal(status?.weekly?.remainingPercent, 100);
		assert.equal(formatModelUsageStatusLabel(status, now), `99% ████▉ ${formatExpectedResetDuration(now + 42 * 60 * 1000, now)} • 100% █████ ${formatExpectedResetDuration(now + 5 * 24 * 60 * 60 * 1000, now)}`);
	});

	it("falls back to top-level Codex limits when no named bucket matches the selected model", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "prolite",
			rate_limit: {
				limit_reached: false,
				primary_window: { used_percent: 25, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 2 * 60 * 60 },
				secondary_window: { used_percent: 20, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
			},
			additional_rate_limits: [{
				limit_name: "GPT-5.3-Codex-Spark",
				metered_feature: "codex_bengalfox",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 1, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 42 * 60 },
					secondary_window: { used_percent: 0, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
				},
			}],
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(status?.hourly?.remainingPercent, 75);
		assert.equal(status?.weekly?.remainingPercent, 80);
	});

	it("matches OpenAI additional model limits by full token sequence", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "prolite",
			rate_limit: null,
			additional_rate_limits: [{
				limit_name: "GPT-5.5 Codex",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 30, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 60 * 60 },
					secondary_window: null,
				},
			}, {
				limit_name: "GPT-5.3-Codex-Spark",
				rate_limit: {
					limit_reached: false,
					primary_window: { used_percent: 1, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 42 * 60 },
					secondary_window: null,
				},
			}],
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(status?.hourly?.remainingPercent, 70);
	});

	it("extracts Zhipu 5-hour token window as hourly equivalent", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const resetAt = now + 3 * 60 * 60 * 1000;
		const response = {
			code: 200,
			msg: "ok",
			data: {
				limits: [
					{ type: "TOKENS_LIMIT" as const, usage: 1000000, currentValue: 350000, percentage: 35, nextResetTime: resetAt },
				],
			},
			success: true,
		};

		const status = zhipuUsageStatusFromResponse(response, "zai/glm-5.1", now);

		assert.equal(status?.provider, "zhipu");
		assert.equal(status?.hourly?.remainingPercent, 65);
		assert.equal(status?.weekly, undefined);
		assert.equal(modelUsageRemainingPercent(status), 65);
		assert.equal(formatModelUsageStatusLabel(status, now), `65% ███▎  ${formatExpectedResetDuration(resetAt, now)}`);
	});

	it("extracts Google Antigravity quota for the active account and model bucket", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const descriptor = {
			kind: "google-antigravity",
			modelKey: "antigravity/G3@user@example.com",
			quotaModelKey: "gemini-3.1-pro-low",
			account: {
				email: "user@example.com",
				refreshToken: "refresh-token",
				projectId: "project-id",
				cacheKey: "user@example.com",
			},
		} as const satisfies Extract<ModelUsageDescriptor, { kind: "google-antigravity" }>;
		const response = {
			models: {
				"gemini-3.1-pro-low": {
					quotaInfo: {
						remainingFraction: 0.99,
						resetTime: new Date(now + (6 * 24 + 22) * 60 * 60 * 1000).toISOString(),
					},
				},
			},
		};

		const status = googleAntigravityUsageStatusFromResponse(response, descriptor, now);

		assert.equal(status?.provider, "google-antigravity");
		assert.equal(status?.accountEmail, "user@example.com");
		assert.equal(status?.weekly?.remainingPercent, 99);
		assert.equal(status?.hourly, undefined);
		assert.equal(formatModelUsageStatusLabel(status, now), `user@example.com 99% ████▉ ${formatExpectedResetDuration(now + (6 * 24 + 22) * 60 * 60 * 1000, now)}`);
	});

	it("formats the local account quota report", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const report: AccountUsageReport = {
			generatedAt: now,
			openai: {
				account: "user@example.com",
				planType: "prolite",
				limitReached: false,
				windows: [
					{ label: "5-hour limit", remainingPercent: 92, resetAt: now + (3 * 60 + 59) * 60 * 1000, windowSeconds: 5 * 60 * 60 },
					{ label: "7-day limit", remainingPercent: 94, resetAt: now + (6 * 24 + 11) * 60 * 60 * 1000, windowSeconds: 7 * 24 * 60 * 60 },
				],
				additionalLimits: [{
					name: "GPT-5.3-Codex-Spark",
					meteredFeature: "codex_bengalfox",
					limitReached: false,
					windows: [
						{ label: "5-hour limit", remainingPercent: 99, resetAt: now + 42 * 60 * 1000, windowSeconds: 5 * 60 * 60 },
						{ label: "7-day limit", remainingPercent: 100, resetAt: now + 5 * 24 * 60 * 60 * 1000, windowSeconds: 7 * 24 * 60 * 60 },
					],
				}],
			},
			zai: {
				account: "660b****PFdj",
				windows: [{ label: "5-hour token limit", remainingPercent: 99, resetAt: now + (3 * 60 + 49) * 60 * 1000, windowSeconds: 5 * 60 * 60 }],
				mcp: { label: "MCP monthly quota", remainingPercent: 100, resetAt: now, windowSeconds: 30 * 24 * 60 * 60, used: 0, limit: 1000 },
			},
			googleAccounts: [{
				account: "limited@example.com",
				limitReached: true,
				windows: [
					{ label: "Claude Opus", remainingPercent: 0, resetAt: now + (6 * 24 + 13) * 60 * 60 * 1000, windowSeconds: (6 * 24 + 13) * 60 * 60 },
					{ label: "G3 Pro", remainingPercent: 100, resetAt: now + 7 * 24 * 60 * 60 * 1000, windowSeconds: 7 * 24 * 60 * 60 },
				],
			}],
		};

		const output = formatAccountUsageReport(report, now);

		assert.match(output, /OpenAI Account Quota/u);
		assert.match(output, /Account:\s+user@example\.com \(prolite\)/u);
		assert.match(output, /5-hour limit\n█{28}░{2} 92% remaining\nResets in: 3h 59m/u);
		assert.match(output, /Additional limit: GPT-5\.3-Codex-Spark\nMetered feature:\s+codex_bengalfox/u);
		assert.match(output, /5-hour limit\n█{30} 99% remaining\nResets in: 42m/u);
		assert.match(output, /MCP monthly quota\n█{30} 100% remaining\nUsed: 0 \/ 1,000/u);
		assert.match(output, /limited@example\.com/u);
		assert.match(output, /Claude Opus\s+6d13h\s+░{20} 0%/u);
		assert.match(output, /⚠️ Rate limit reached!/u);
	});

	it("reads Antigravity account quotas from Pi auth.json cached quota", async () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const cachedAt = now - 30 * 24 * 60 * 60 * 1000;
		await withPiAuthAsync({
			antigravity: {
				type: "oauth",
				email: "fallback@example.com",
				accounts: [{
					email: "cached@example.com",
					refreshToken: "refresh-token",
					projectId: "project-id",
					enabled: true,
					cachedQuotaUpdatedAt: cachedAt,
					cachedQuota: {
						claude: { remainingFraction: 0.5, resetTime: new Date(cachedAt + 7 * 24 * 60 * 60 * 1000).toISOString() },
						"gemini-flash": { remainingFraction: 1, resetTime: new Date(cachedAt + 60 * 60 * 1000).toISOString() },
						"gemini-pro": { remainingFraction: 0.25, resetTime: new Date(cachedAt + 2 * 60 * 60 * 1000).toISOString() },
					},
				}],
				activeIndex: 0,
			},
		}, async () => {
			const report = await queryAccountUsageReport(now);

			assert.equal(report.googleAccounts.length, 1);
			assert.equal(report.googleAccounts[0]?.account, "cached@example.com");
			assert.deepEqual(report.googleAccounts[0]?.windows.map((window) => [window.label, window.remainingPercent]), [
				["Claude Opus", 50],
				["Claude Sonnet", 50],
				["G2.5 Flash", 100],
				["G3 Flash", 100],
				["G3 Pro", 25],
			]);
			assert.deepEqual(report.googleAccounts[0]?.windows.map((window) => [window.label, window.resetAt - now]), [
				["Claude Opus", 7 * 24 * 60 * 60 * 1000],
				["Claude Sonnet", 7 * 24 * 60 * 60 * 1000],
				["G2.5 Flash", 60 * 60 * 1000],
				["G3 Flash", 60 * 60 * 1000],
				["G3 Pro", 2 * 60 * 60 * 1000],
			]);
		});
	});
	it("returns empty labels and no descriptor when quota data is unavailable", () => {
		assert.equal(formatModelUsageStatusLabel(undefined), "");
		assert.equal(modelUsageRemainingPercent(undefined), undefined);
		withPiAuth({}, () => {
			assert.equal(modelUsageDescriptor({ provider: "antigravity", id: "G3" } as SessionModel), undefined);
		});
	});

});

function withPiAuth(auth: unknown, run: () => void): void {
	const previousNodeEnv = process.env.NODE_ENV;
	const previousAuthPath = process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
	const agentDir = mkdtempSync(join(tmpdir(), "pix-agent-"));
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify(auth), "utf8");
	process.env.NODE_ENV = "test";
	process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = authPath;
	try {
		run();
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
		if (previousAuthPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		else process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = previousAuthPath;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

async function withPiAuthAsync(auth: unknown, run: () => Promise<void>): Promise<void> {
	const previousNodeEnv = process.env.NODE_ENV;
	const previousAuthPath = process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
	const agentDir = mkdtempSync(join(tmpdir(), "pix-agent-"));
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify(auth), "utf8");
	process.env.NODE_ENV = "test";
	process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = authPath;
	try {
		await run();
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
		if (previousAuthPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		else process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = previousAuthPath;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function formatExpectedResetDuration(resetAt: number, now: number): string {
	// Mirrors formatDurationShort in src/app/model/model-usage-status.ts
	if (resetAt <= now) return "reset";
	const totalMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${minutes}m`;
	return `${minutes}m`;
}
