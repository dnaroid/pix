import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	anthropicUsageStatusFromResponse,
	type AnthropicUsageResponse,
	formatAccountUsageReport,
	formatModelUsageStatusLabel,
	googleAntigravityUsageStatusFromResponse,
	modelUsageDescriptor,
	modelUsageRemainingPercent,
	markModelUsageStale,
	liveStaleModelUsage,
	openAIResetCreditsFromResponse,
	openAIUsageStatusFromResponse,
	queryAccountUsageReport,
	queryModelUsageStatus,
	resolveAntigravityQuotaModelKey,
	type AccountUsageReport,
	zhipuUsageStatusFromResponse,
	type ModelUsageDescriptor,
	type OpenAIResetCreditsResponse,
	type OpenAIUsageResponse,
} from "../src/app/model/model-usage-status.js";
import { APP_ICONS } from "../src/app/icons.js";
import type { SessionModel } from "../src/app/types.js";
import { claudeCodeKeychainService, tokenFromClaudeCredential } from "../src/app/model/claude-code-usage-auth.js";

describe("model usage status", () => {
	it("expires cached Claude quota windows independently", () => {
		const now = Date.UTC(2026, 0, 1);
		const status = {
			provider: "anthropic" as const,
			modelKey: "pi-claude-code-provider/opus",
			updatedAt: now,
			hourly: { remainingPercent: 20, resetAt: now + 1_000, windowSeconds: 18_000 },
			weekly: { remainingPercent: 70, resetAt: now + 3_000, windowSeconds: 604_800 },
		};
		assert.equal(markModelUsageStale(status, now + 1_001)?.hourly, undefined);
		assert.equal(markModelUsageStale(status, now + 1_001)?.weekly?.remainingPercent, 70);
		assert.equal(liveStaleModelUsage(markModelUsageStale(status, now), now + 3_000), undefined);
	});
	it("builds descriptors for OpenAI quota-backed models only", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "openai-codex", id: "gpt-5.5" } as SessionModel), {
			kind: "openai",
			modelKey: "openai-codex/gpt-5.5",
		});
		assert.equal(modelUsageDescriptor({ provider: "openrouter", id: "gpt-5.5" } as SessionModel), undefined);
	});

	it("builds descriptors for Anthropic subscription models", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "anthropic", id: "claude-opus-4-7" } as SessionModel), {
			kind: "anthropic",
			modelKey: "anthropic/claude-opus-4-7",
		});
	});

	it("recognizes the Claude Code adapter separately from Pi Anthropic auth", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "pi-claude-code-provider", id: "opus" } as SessionModel), {
			kind: "claude-code", modelKey: "pi-claude-code-provider/opus",
		});
		const now = Date.UTC(2026, 0, 1);
		const credential = (expiresAt: number, accessToken = "sk-ant-oat-fixture") => JSON.stringify({
			claudeAiOauth: { accessToken, expiresAt },
		});
		assert.equal(tokenFromClaudeCredential(credential(now + 1000), now), "sk-ant-oat-fixture");
		assert.equal(tokenFromClaudeCredential(credential(now), now), undefined);
		assert.equal(tokenFromClaudeCredential(credential(now + 1000, "sk-ant-api-fixture"), now), undefined);
		assert.equal(tokenFromClaudeCredential("not JSON", now), undefined);
		assert.equal(claudeCodeKeychainService(), "Claude Code-credentials");
		assert.equal(claudeCodeKeychainService("/tmp/claude-profile/"), claudeCodeKeychainService("/tmp/claude-profile"));
		assert.match(claudeCodeKeychainService("/tmp/claude-profile"), /^Claude Code-credentials-[a-f0-9]{8}$/u);
	});

	it("queries Claude Code subscription usage from isolated local credentials, not Pi auth", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pix-claude-usage-"));
		const path = join(dir, ".credentials.json");
		const previousPath = process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH;
		const previousNodeEnv = process.env.NODE_ENV;
		const oldFetch = globalThis.fetch;
		let requests = 0;
		process.env.NODE_ENV = "test";
		process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH = path;
		globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			requests++;
			assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer sk-ant-oat-claude-fixture");
			return Response.json({ five_hour: { utilization: 20 }, seven_day: { utilization: 60 } });
		}) as typeof fetch;
		try {
			const descriptor = modelUsageDescriptor({ provider: "pi-claude-code-provider", id: "opus" } as SessionModel)!;
			writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-claude-fixture", expiresAt: Date.now() + 60_000 } }));
			await withPiAuthAsync({ anthropic: { type: "api_key", key: "sk-ant-api-fixture" } }, async () => {
				assert.equal((await queryModelUsageStatus(descriptor))?.hourly?.remainingPercent, 80);
				assert.equal((await queryModelUsageStatus(descriptor))?.weekly?.remainingPercent, 40);
			});
			assert.equal(requests, 2);
			writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-claude-fixture", expiresAt: Date.now() - 1000 } }));
			assert.equal(await queryModelUsageStatus(descriptor), undefined);
			assert.equal(requests, 2);
		} finally {
			globalThis.fetch = oldFetch;
			if (previousPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH;
			else process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH = previousPath;
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("extracts Anthropic 5-hour and the most constrained weekly window", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const data: AnthropicUsageResponse = {
			five_hour: { utilization: 12.4, resets_at: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
			seven_day: { utilization: 30, resets_at: new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString() },
			seven_day_opus: { utilization: 55, resets_at: new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString() },
			seven_day_sonnet: null,
		};

		const opus = anthropicUsageStatusFromResponse(data, "anthropic/claude-opus-4-7", now);
		assert.equal(opus?.provider, "anthropic");
		assert.deepEqual(opus?.hourly, { remainingPercent: 88, resetAt: now + 2 * 60 * 60 * 1000, windowSeconds: 5 * 60 * 60, hasKnownWindowDuration: true });
		assert.equal(opus?.weekly?.remainingPercent, 45);
		assert.equal(opus?.weekly?.resetAt, now + 4 * 24 * 60 * 60 * 1000);

		const sonnet = anthropicUsageStatusFromResponse(data, "anthropic/claude-sonnet-4-6", now);
		assert.equal(sonnet?.weekly?.remainingPercent, 70);

		const unused = anthropicUsageStatusFromResponse({ five_hour: { utilization: 0, resets_at: null } }, "anthropic/claude-haiku-4-5", now);
		assert.deepEqual(unused?.hourly, { remainingPercent: 100, resetAt: now + 5 * 60 * 60 * 1000, windowSeconds: 5 * 60 * 60, hasKnownWindowDuration: true });
		assert.equal(unused?.weekly, undefined);
		assert.equal(anthropicUsageStatusFromResponse({}, "anthropic/claude-opus-4-7", now), undefined);
	});

	it("queries Anthropic usage with Claude OAuth tokens from auth.json or env and skips API keys", async () => {
		const oldFetch = globalThis.fetch;
		let usageRequests = 0;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			if (url !== "https://api.anthropic.com/api/oauth/usage") throw new Error(`Unexpected fetch: ${url}`);
			usageRequests += 1;
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("Authorization"), "Bearer sk-ant-oat-test");
			assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
			return Response.json({ five_hour: { utilization: 40, resets_at: null }, seven_day: { utilization: 10, resets_at: null } });
		}) as typeof fetch;

		try {
			const descriptor = modelUsageDescriptor({ provider: "anthropic", id: "claude-sonnet-4-6" } as SessionModel);
			if (!descriptor) throw new Error("Expected Anthropic usage descriptor");

			await withPiAuthAsync({
				anthropic: { type: "oauth", access: "sk-ant-oat-test", refresh: "refresh", expires: Date.now() + 60_000 },
			}, async () => {
				const status = await queryModelUsageStatus(descriptor);
				assert.equal(status?.hourly?.remainingPercent, 60);
				assert.equal(status?.weekly?.remainingPercent, 90);

				const report = await queryAccountUsageReport();
				assert.deepEqual(report.anthropic?.windows.map((window) => [window.label, window.remainingPercent]), [
					["5-hour limit", 60],
					["7-day limit", 90],
				]);
				assert.match(formatAccountUsageReport(report), /Anthropic Account Quota/u);
			});
			assert.equal(usageRequests, 2);

			await withPiAuthAsync({ anthropic: { type: "api_key", key: "sk-ant-api" } }, async () => {
				assert.equal(await queryModelUsageStatus(descriptor), undefined);
				assert.equal((await queryAccountUsageReport()).anthropic, undefined);
			});
			assert.equal(usageRequests, 2);

			await withPiAuthAsync({ anthropic: { type: "api_key", key: "sk-ant-oat-test" } }, async () => {
				assert.equal((await queryModelUsageStatus(descriptor))?.hourly?.remainingPercent, 60);
			});
			assert.equal(usageRequests, 3);

			const previousOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;
			process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat-test";
			try {
				await withPiAuthAsync({}, async () => {
					assert.equal((await queryModelUsageStatus(descriptor))?.weekly?.remainingPercent, 90);
				});
			} finally {
				if (previousOAuthToken === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
				else process.env.ANTHROPIC_OAUTH_TOKEN = previousOAuthToken;
			}
			assert.equal(usageRequests, 4);
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("builds descriptors for Zhipu/Z.ai quota-backed models", () => {
		assert.deepEqual(modelUsageDescriptor({ provider: "zai", id: "glm-5.2" } as SessionModel), {
			kind: "zhipu",
			modelKey: "zai/glm-5.2",
		});
		assert.deepEqual(modelUsageDescriptor({ provider: "zhipuai-coding-plan", id: "glm-4" } as SessionModel), {
			kind: "zhipu",
			modelKey: "zhipuai-coding-plan/glm-4",
		});
	});

	it("builds Antigravity descriptors without reading auth synchronously", () => {
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
			assert.equal(descriptor?.modelKey, "antigravity/G3");
			if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");
			assert.equal(descriptor.quotaModelKey, "gemini-3.1-pro-low");
			assert.equal(descriptor.account, undefined);
			assert.equal(descriptor.accounts, undefined);
		});
	});

	it("maps Antigravity model aliases to Google quota buckets", () => {
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "G3" } as SessionModel), "gemini-3.1-pro-low");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "G3 Flash" } as SessionModel), "gemini-3-flash");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "gemini-2.5-flash" } as SessionModel), "gemini-2.5-flash");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-claude-opus-4-6-thinking" } as SessionModel), "claude-opus-4-6-thinking");
		// Legacy aliases keep resolving to the original buckets.
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-gemini-3-flash" } as SessionModel), "gemini-3-flash");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-claude-sonnet-4-6" } as SessionModel), "claude-sonnet-4-6");
	});

	it("maps current Antigravity catalog models to versioned quota buckets", () => {
		for (const version of [5, 6, 7, 8]) {
			assert.equal(
				resolveAntigravityQuotaModelKey({ provider: "antigravity", id: `antigravity-gemini-3.${version}-flash` } as SessionModel),
				`gemini-3.${version}-flash`,
			);
			assert.equal(
				resolveAntigravityQuotaModelKey({ provider: "antigravity", id: `Gemini 3.${version} Flash` } as SessionModel),
				`gemini-3.${version}-flash`,
			);
		}
		// Sonnet thinking shares the base Sonnet bucket; the 3.1 Pro bucket is
		// unchanged; GPT-OSS has no Google-side bucket.
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-claude-sonnet-4-6-thinking" } as SessionModel), "claude-sonnet-4-6");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-gemini-3.1-pro" } as SessionModel), "gemini-3.1-pro-low");
		assert.equal(resolveAntigravityQuotaModelKey({ provider: "antigravity", id: "antigravity-gpt-oss-120b-medium" } as SessionModel), undefined);
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

	it("warns when a multi-day status-bar limit will exhaust before reset at the current pace", () => {
		const now = Date.UTC(2026, 0, 3, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "plus",
			rate_limit: {
				limit_reached: false,
				primary_window: {
					used_percent: 60,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_after_seconds: 5 * 24 * 60 * 60,
				},
				secondary_window: null,
			},
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(formatModelUsageStatusLabel(status, now), `40% ██    ${APP_ICONS.alert} ${formatExpectedResetDuration(now + 5 * 24 * 60 * 60 * 1000, now)}`);
	});

	it("does not warn from tiny early-window usage spikes", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const response: OpenAIUsageResponse = {
			plan_type: "plus",
			rate_limit: {
				limit_reached: false,
				primary_window: {
					used_percent: 2,
					limit_window_seconds: 7 * 24 * 60 * 60,
					reset_after_seconds: 6 * 24 * 60 * 60 + 23 * 60 * 60,
				},
				secondary_window: null,
			},
		};

		const status = openAIUsageStatusFromResponse(response, "openai-codex/gpt-5.5", now);

		assert.equal(formatModelUsageStatusLabel(status, now), `98% ████▉ ${formatExpectedResetDuration(now + (6 * 24 + 23) * 60 * 60 * 1000, now)}`);
	});

	it("does not warn for exhausted or single-day-and-shorter status-bar limits", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const exhausted: OpenAIUsageResponse = {
			plan_type: "plus",
			rate_limit: {
				limit_reached: true,
				primary_window: { used_percent: 100, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
				secondary_window: { used_percent: 80, limit_window_seconds: 5 * 60 * 60, reset_after_seconds: 2 * 60 * 60 },
			},
		};

		const status = openAIUsageStatusFromResponse(exhausted, "openai-codex/gpt-5.5", now);

		assert.equal(formatModelUsageStatusLabel(status, now), `20% █     ${formatExpectedResetDuration(now + 2 * 60 * 60 * 1000, now)} • 0%       ${formatExpectedResetDuration(now + 5 * 24 * 60 * 60 * 1000, now)}`);
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

	it("keeps only available live Codex reset credits, sorts by expiry, and supports credits without quota windows", () => {
		const now = Date.UTC(2026, 9, 4, 20, 0, 0);
		const soon = now + 10 * 60 * 60 * 1000;
		const later = now + 20 * 24 * 60 * 60 * 1000;
		const response: OpenAIResetCreditsResponse = {
			available_count: 3,
			credits: [
				{ status: "available", title: " Later reset ", expires_at: new Date(later).toISOString() },
				{ status: "available", title: "Full reset", expires_at: new Date(soon).toISOString() },
				{ status: "available", title: null, expires_at: null },
				{ status: "used", title: "Used reset", expires_at: new Date(later).toISOString() },
				{ status: "available", title: "Expired reset", expires_at: new Date(now - 1).toISOString() },
			],
		};

		const credits = openAIResetCreditsFromResponse(response, now);
		assert.deepEqual(credits, [
			{ title: "Full reset", expiresAt: soon },
			{ title: "Later reset", expiresAt: later },
			{ title: "Reset credit" },
		]);
		const status = openAIUsageStatusFromResponse(
			{ plan_type: "plus", rate_limit: null },
			"openai-codex/gpt-5.5",
			now,
			credits,
		);
		assert.deepEqual(status?.resetCredits, credits);
		assert.equal(status?.weekly, undefined);
		assert.equal(status?.hourly, undefined);
	});

	it("loads reset-credit details with the OpenAI quota snapshot and treats credit endpoint failures as supplementary", async () => {
		const oldFetch = globalThis.fetch;
		const access = testJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-live" } });
		const expiry = Date.now() + 6 * 60 * 60 * 1000;
		let creditRequests = 0;
		let failCredits = false;
		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("Authorization"), `Bearer ${access}`);
			assert.equal(headers.get("ChatGPT-Account-Id"), "account-live");
			if (url === "https://chatgpt.com/backend-api/wham/usage") {
				return Response.json({
					plan_type: "plus",
					rate_limit: {
						limit_reached: false,
						primary_window: { used_percent: 26, limit_window_seconds: 7 * 24 * 60 * 60, reset_after_seconds: 5 * 24 * 60 * 60 },
						secondary_window: null,
					},
				});
			}
			if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
				creditRequests += 1;
				if (failCredits) return new Response("busy", { status: 429 });
				return Response.json({
					available_count: 1,
					credits: [{ status: "available", title: "Full reset", expires_at: new Date(expiry).toISOString() }],
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				"openai-codex": { type: "oauth", access, refresh: "unused", expires: Date.now() + 60 * 60 * 1000 },
			}, async () => {
				const descriptor = modelUsageDescriptor({ provider: "openai-codex", id: "gpt-5.5" } as SessionModel);
				if (!descriptor) throw new Error("Expected OpenAI usage descriptor");
				const withCredits = await queryModelUsageStatus(descriptor);
				assert.equal(withCredits?.weekly?.remainingPercent, 74);
				assert.deepEqual(withCredits?.resetCredits, [{ title: "Full reset", expiresAt: expiry }]);

				failCredits = true;
				const withoutCredits = await queryModelUsageStatus(descriptor);
				assert.equal(withoutCredits?.weekly?.remainingPercent, 74);
				assert.equal(withoutCredits?.resetCredits, undefined);
			});
			assert.equal(creditRequests, 2);
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("does not invent expiry dates or expose non-available reset-credit statuses", () => {
		const now = Date.UTC(2026, 9, 4);
		assert.deepEqual(openAIResetCreditsFromResponse({ credits: [
			{ status: "available", title: " ", expires_at: "not a date", future_field: true },
			{ status: "available", title: 42, expires_at: {} },
			{ status: "available", title: "Expires now", expires_at: new Date(now).toISOString() },
			...["redeeming", "redeemed", "used", "expired", "revoked", "future-status", undefined].map((status) => ({ status, title: "Hidden" })),
			null,
		] }, now), [{ title: "Reset credit" }, { title: "Reset credit" }]);
		assert.deepEqual(openAIResetCreditsFromResponse({ available_count: 3, credits: [] }, now), []);
	});

	it("deduplicates opaque credit IDs without collapsing distinct credits with matching titles and expiries", () => {
		const credit = { id: "one", status: "available", title: "Full reset", expires_at: "2026-10-05T06:19:37+02:00" };
		const now = Date.UTC(2026, 9, 4);
		assert.deepEqual(openAIResetCreditsFromResponse({ credits: [credit, credit, { ...credit, id: "two" }] }, now), [
			{ title: "Full reset", expiresAt: 1791173977000 }, { title: "Full reset", expiresAt: 1791173977000 },
		]);
	});

	it("accepts RFC3339 offsets but never guesses local timestamps or numeric app-server seconds", () => {
		const now = Date.UTC(2026, 9, 4);
		const dates = ["2026-10-05T06:19:37+02:00", "2026-10-22T22:32:35+02:00", "2026-10-29T19:59:44+01:00"];
		assert.deepEqual(openAIResetCreditsFromResponse({ credits: dates.map((expires_at) => ({ status: "available", expires_at })) }, now)
			.map((credit) => credit.expiresAt), [1791173977000, 1792701155000, 1793300384000]);
		for (const expires_at of [1791173977, "1791173977", "2026-10-05T06:19:37", "10/05/2026", "2027-02-30T06:00:00Z", "2026-10-05T24:00:00Z"]) {
			assert.equal(openAIResetCreditsFromResponse({ credits: [{ status: "available", expires_at }] }, now)[0]?.expiresAt, undefined);
		}
	});

	it("retains the authoritative total for capped details and summary-only failures without quota windows", async () => {
		const oldFetch = globalThis.fetch;
		let details: unknown = { available_count: 3, credits: [{ id: "one", status: "available", title: "Full reset" }] };
		let failed = false;
		globalThis.fetch = (async (input) => String(input).endsWith("/usage")
			? Response.json({ rate_limit_reset_credits: { available_count: 5 } })
			: failed ? new Response("unavailable", { status: 503 }) : Response.json(details)) as typeof fetch;
		try {
			await withPiAuthAsync({ "openai-codex": { type: "oauth", access: "fixture", expires: Date.now() + 60_000 } }, async () => {
				const query = () => queryModelUsageStatus({ kind: "openai", modelKey: "openai-codex/test" });
				const capped = await query();
				assert.equal(capped?.resetCreditsAvailableCount, 3);
				assert.equal(capped?.resetCredits?.length, 1);
				failed = true;
				const fallback = await query();
				assert.equal(fallback?.resetCreditsAvailableCount, 5);
				assert.equal(fallback?.resetCredits, undefined);
				failed = false;
				details = { available_count: 0, credits: [{ status: "available", title: "Full reset" }] };
				assert.equal(await query(), undefined, "zero details total must win over older usage summary");
				details = { available_count: 3, credits: [{ status: "available", expires_at: new Date(Date.now() - 1).toISOString() }] };
				assert.equal((await query())?.resetCreditsAvailableCount, 2);
				details = { available_count: "garbage", credits: [] };
				assert.equal((await query())?.resetCreditsAvailableCount, 5);
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("keeps ordinary quota available when reset-credit JSON has an unexpected shape", async () => {
		const oldFetch = globalThis.fetch;
		let payload: unknown;
		globalThis.fetch = (async (input) => String(input).endsWith("/usage")
			? Response.json({ rate_limit: { primary_window: { used_percent: 26, limit_window_seconds: 604800, reset_after_seconds: 3600 } } })
			: Response.json(payload)) as typeof fetch;
		try {
			await withPiAuthAsync({ "openai-codex": { type: "oauth", access: "fixture", expires: Date.now() + 60_000 } }, async () => {
				for (payload of [null, [], { credits: {} }, { credits: [null, { status: "available", title: 42 }] }]) {
					const status = await queryModelUsageStatus({ kind: "openai", modelKey: "openai-codex/gpt-5.5" });
					assert.equal(status?.weekly?.remainingPercent, 74);
				}
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("uses the Pi Codex account for credits even when OpenCode is logged into another account", async () => {
		const home = mkdtempSync(join(tmpdir(), "pix-codex-account-"));
		const previousHome = process.env.HOME;
		const oldFetch = globalThis.fetch;
		const access = testJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "pi-account" } });
		const requests: string[] = [];
		mkdirSync(join(home, ".local/share/opencode"), { recursive: true });
		writeFileSync(join(home, ".local/share/opencode/auth.json"), JSON.stringify({
			openai: { type: "oauth", access: "other-account", expires: Date.now() + 60_000 },
		}));
		process.env.HOME = home;
		globalThis.fetch = (async (input, init) => {
			requests.push(String(input));
			assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${access}`);
			assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "pi-account");
			return Response.json(String(input).endsWith("/usage") ? {} : { credits: [{ status: "available", title: "Full reset" }] });
		}) as typeof fetch;
		try {
			await withPiAuthAsync({ "openai-codex": { type: "oauth", access, expires: Date.now() + 60_000 } }, async () => {
				assert.equal((await queryModelUsageStatus({ kind: "openai", modelKey: "openai-codex/gpt-5.5" }))?.resetCredits?.length, 1);
			});
			assert.equal(requests.length, 2);
			await withPiAuthAsync({}, async () => {
				assert.equal(await queryModelUsageStatus({ kind: "openai", modelKey: "openai-codex/gpt-5.5" }), undefined);
			});
			assert.equal(requests.length, 2, "missing Pi auth must not fall back to a different application's account");
		} finally {
			globalThis.fetch = oldFetch;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("bounds the supplementary reset-credit response body, not just its headers", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const oldFetch = globalThis.fetch;
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		let started!: () => void;
		const creditStarted = new Promise<void>((resolve) => { started = resolve; });
		globalThis.fetch = (async (input, init) => {
			if (String(input).endsWith("/usage")) {
				return Response.json({ rate_limit: { primary_window: { used_percent: 26, limit_window_seconds: 604800, reset_after_seconds: 3600 } } });
			}
			const stream = new ReadableStream<Uint8Array>({ start(controller) { body = controller; } });
			init?.signal?.addEventListener("abort", () => body?.error(new Error("aborted")), { once: true });
			started();
			return new Response(stream);
		}) as typeof fetch;
		try {
			await withPiAuthAsync({ "openai-codex": { type: "oauth", access: "fixture", expires: Date.now() + 60_000 } }, async () => {
				let settled = false;
				const pending = queryModelUsageStatus({ kind: "openai", modelKey: "openai-codex/gpt-5.5" })
					.then((status) => { settled = true; return status; });
				await creditStarted;
				await new Promise<void>((resolve) => setImmediate(resolve));
				t.mock.timers.tick(10_000);
				await new Promise<void>((resolve) => setImmediate(resolve));
				assert.equal(settled, true, "stalled credit body must not indefinitely block ordinary quota");
				assert.equal((await pending)?.weekly?.remainingPercent, 74);
			});
		} finally {
			body?.error(new Error("test cleanup"));
			globalThis.fetch = oldFetch;
			t.mock.timers.reset();
		}
	});

	it("refreshes expired OpenAI Codex OAuth and persists the rotated credential", async () => {
		const oldFetch = globalThis.fetch;
		const refreshedAccess = testJwt({
			email: "user@example.com",
			"https://api.openai.com/auth": { chatgpt_account_id: "account-refreshed" },
		});
		let tokenRequests = 0;
		let usageRequests = 0;
		let creditRequests = 0;

		globalThis.fetch = (async (
			input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			const url = String(input);
			if (url === "https://auth.openai.com/oauth/token") {
				tokenRequests += 1;
				assert.equal(init?.method, "POST");
				assert.equal(String(init?.body), "grant_type=refresh_token&refresh_token=refresh-old&client_id=app_EMoamEEZ73f0CkXaXp7hrann");
				return Response.json({
					access_token: refreshedAccess,
					refresh_token: "refresh-rotated",
					expires_in: 3600,
				});
			}
			if (url === "https://chatgpt.com/backend-api/wham/usage") {
				usageRequests += 1;
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("Authorization"), `Bearer ${refreshedAccess}`);
				assert.equal(headers.get("ChatGPT-Account-Id"), "account-refreshed");
				return Response.json({
					rate_limit: {
						limit_reached: false,
						primary_window: {
							used_percent: 0,
							limit_window_seconds: 7 * 24 * 60 * 60,
							reset_after_seconds: 6 * 24 * 60 * 60,
						},
						secondary_window: null,
					},
				});
			}
			if (url === "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits") {
				creditRequests += 1;
				assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${refreshedAccess}`);
				assert.equal(new Headers(init?.headers).get("ChatGPT-Account-Id"), "account-refreshed");
				return Response.json({ credits: [{ status: "available", title: "Full reset" }] });
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				"openai-codex": {
					type: "oauth",
					access: testJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-old" } }),
					refresh: "refresh-old",
					expires: Date.now() - 1_000,
					accountId: "account-old",
				},
			}, async (authPath) => {
				const descriptor = modelUsageDescriptor({ provider: "openai-codex", id: "gpt-5.5" } as SessionModel);
				if (!descriptor) throw new Error("Expected OpenAI usage descriptor");

				const status = await queryModelUsageStatus(descriptor);
				const persisted = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

				assert.equal(status?.weekly?.remainingPercent, 100);
				assert.equal(tokenRequests, 1);
				assert.equal(usageRequests, 1);
				assert.equal(creditRequests, 1);
				assert.equal(status?.resetCredits?.length, 1);
				assert.equal(persisted["openai-codex"]?.access, refreshedAccess);
				assert.equal(persisted["openai-codex"]?.refresh, "refresh-rotated");
				assert.equal(persisted["openai-codex"]?.accountId, "account-refreshed");
				assert.ok(Number(persisted["openai-codex"]?.expires) > Date.now());
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("rejects when an expired OpenAI Codex credential cannot be refreshed", async () => {
		const oldFetch = globalThis.fetch;
		globalThis.fetch = (async () => new Response("invalid_grant", { status: 400 })) as typeof fetch;

		try {
			await withPiAuthAsync({
				"openai-codex": {
					type: "oauth",
					access: testJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-old" } }),
					refresh: "refresh-invalid",
					expires: Date.now() - 1_000,
					accountId: "account-old",
				},
			}, async () => {
				const descriptor = modelUsageDescriptor({ provider: "openai-codex", id: "gpt-5.5" } as SessionModel);
				if (!descriptor) throw new Error("Expected OpenAI usage descriptor");

				await assert.rejects(queryModelUsageStatus(descriptor), /OAuth token refresh failed/u);
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
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

		const status = zhipuUsageStatusFromResponse(response, "zai/glm-5.2", now);

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

	it("uses the active Antigravity route quota for xhigh versioned Flash", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const descriptor = modelUsageDescriptor(
			{ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel,
			"xhigh",
		);
		if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");
		assert.deepEqual(descriptor.quotaModelCandidates, ["gemini-3.8-flash", "gemini-3.8-flash-high"]);

		const status = googleAntigravityUsageStatusFromResponse({
			models: {
				"gemini-3.8-flash-high": {
					quotaInfo: {
						remainingFraction: 0.67,
						resetTime: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
					},
				},
			},
		}, descriptor, now);

		assert.equal(status?.hourly?.remainingPercent, 67);
	});

	it("does not substitute a legacy live Flash bucket for a missing current Antigravity bucket", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const descriptor = {
			kind: "google-antigravity",
			modelKey: "antigravity/antigravity-gemini-3.8-flash",
			quotaModelKey: "gemini-3.8-flash",
			account: {
				email: "user@example.com",
				refreshToken: "refresh-token",
				projectId: "project-id",
				cacheKey: "user@example.com",
			},
		} as const satisfies Extract<ModelUsageDescriptor, { kind: "google-antigravity" }>;
		const response = {
			models: {
				"gemini-3-flash": {
					quotaInfo: {
						remainingFraction: 0.42,
						resetTime: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
					},
				},
			},
		};

		assert.equal(googleAntigravityUsageStatusFromResponse(response, descriptor, now), undefined);
	});

	it("does not warn for Antigravity reset-only multi-day windows", () => {
		const fetchedAt = Date.UTC(2026, 0, 1, 0, 0, 0);
		const formattedAt = fetchedAt + 2 * 24 * 60 * 60 * 1000;
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
						remainingFraction: 0.4,
						resetTime: new Date(fetchedAt + 7 * 24 * 60 * 60 * 1000).toISOString(),
					},
				},
			},
		};

		const status = googleAntigravityUsageStatusFromResponse(response, descriptor, fetchedAt);

		assert.equal(status?.weekly?.hasKnownWindowDuration, undefined);
		assert.equal(formatModelUsageStatusLabel(status, formattedAt), `user@example.com 40% ██    ${formatExpectedResetDuration(fetchedAt + 7 * 24 * 60 * 60 * 1000, formattedAt)}`);
	});

	it("treats missing Google Antigravity remaining fraction as exhausted quota", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const descriptor = {
			kind: "google-antigravity",
			modelKey: "antigravity/claude@user@example.com",
			quotaModelKey: "claude-opus-4-6-thinking",
			account: {
				email: "user@example.com",
				refreshToken: "refresh-token",
				projectId: "project-id",
				cacheKey: "user@example.com",
			},
		} as const satisfies Extract<ModelUsageDescriptor, { kind: "google-antigravity" }>;
		const response = {
			models: {
				"claude-opus-4-6-thinking": {
					quotaInfo: {
						resetTime: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
					},
				},
			},
		};

		const status = googleAntigravityUsageStatusFromResponse(response, descriptor, now);

		assert.equal(status?.weekly?.remainingPercent, 0);
		assert.equal(formatModelUsageStatusLabel(status, now), `user@example.com 0%       ${formatExpectedResetDuration(now + 7 * 24 * 60 * 60 * 1000, now)}`);
	});

	it("aggregates Google Antigravity status across all accounts", async () => {
		const now = Date.now();
		const weeklyResetAt = now + 7 * 24 * 60 * 60 * 1000;
		const nearestResetAt = now + 22 * 60 * 60 * 1000;
		const cachedAt = now - 60_000;
		await withPiAuthAsync({
			antigravity: {
				type: "oauth",
				email: "active@example.com",
				accounts: [{
					email: "active@example.com",
					refreshToken: "refresh-active",
					projectId: "project-active",
					enabled: true,
					cachedQuotaUpdatedAt: cachedAt,
					cachedQuota: {
						claude: { remainingFraction: 0.42, resetTime: new Date(weeklyResetAt).toISOString() },
					},
				}, {
					email: "limited@example.com",
					refreshToken: "refresh-limited",
					projectId: "project-limited",
					enabled: true,
					cachedQuotaUpdatedAt: cachedAt,
					cachedQuota: {
						claude: { resetTime: new Date(nearestResetAt).toISOString() },
					},
				}],
				activeIndex: 0,
			},
		}, async () => {
			const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "antigravity-claude-opus-4-6-thinking" } as SessionModel);
			if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

			const status = await queryModelUsageStatus(descriptor);

			assert.equal(status?.accountEmail, "Σ");
			assert.equal(status?.hourly?.remainingPercent, 21);
			assert.ok(Math.abs((status?.hourly?.resetAt ?? 0) - nearestResetAt) < 2_000);
			assert.equal(status?.weekly, undefined);
			assert.equal(formatModelUsageStatusLabel(status, now), `Σ 21% █▏    ${formatExpectedResetDuration(nearestResetAt, now)}`);
		});
	});

	it("aggregates native Antigravity weekly quota across the whole account pool", async () => {
		const previousClientId = process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID;
		const previousClientSecret = process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
		const oldFetch = globalThis.fetch;
		const now = Date.now();
		const resetTimes = [
			now + 3 * 24 * 60 * 60 * 1000,
			now + 7 * 24 * 60 * 60 * 1000,
			now + 7 * 24 * 60 * 60 * 1000,
			now + 6 * 24 * 60 * 60 * 1000,
			now + 6 * 24 * 60 * 60 * 1000,
		];
		const remainingByAccess = new Map([
			["access-1", 0.2426112],
			["access-2", 1],
			["access-3", 1],
			["access-4", 0],
			["access-5", 0],
		]);
		process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID = "pool-client-id";
		process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = "pool-client-secret";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				const body = new URLSearchParams(String(init?.body ?? ""));
				const refresh = body.get("refresh_token") ?? "";
				const index = Number(refresh.replace("refresh-", ""));
				return Response.json({ access_token: `access-${index}` });
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
				const authorization = new Headers(init?.headers).get("Authorization") ?? "";
				const access = authorization.replace("Bearer ", "");
				const remainingFraction = remainingByAccess.get(access);
				if (remainingFraction === undefined) throw new Error(`Unexpected access token alias: ${access}`);
				const index = Number(access.replace("access-", "")) - 1;
				return Response.json({
					groups: [{
						buckets: [{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction,
							resetTime: new Date(resetTimes[index] ?? resetTimes[0]).toISOString(),
						}],
					}],
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				antigravity: {
					type: "oauth",
					access: "access-1|project-1",
					expires: now + 60 * 60 * 1000,
					activeIndex: 0,
					accounts: [1, 2, 3, 4, 5].map((index) => ({
						refreshToken: `refresh-${index}`,
						projectId: `project-${index}`,
						enabled: true,
					})),
				},
			}, async () => {
				const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel);
				if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

				const status = await queryModelUsageStatus(descriptor);

				assert.equal(status?.accountEmail, "Σ");
				assert.equal(status?.weekly?.remainingPercent, 45);
				assert.equal(status?.weekly?.hasKnownWindowDuration, true);
				assert.equal(status?.hourly, undefined);
				assert.ok(Math.abs((status?.weekly?.resetAt ?? 0) - resetTimes[0]) < 2_000);
			});
		} finally {
			globalThis.fetch = oldFetch;
			if (previousClientId === undefined) delete process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID;
			else process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID = previousClientId;
			if (previousClientSecret === undefined) delete process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
			else process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = previousClientSecret;
		}
	});

	it("resolves current versioned Antigravity Flash models from the cached shared Flash quota", async () => {
		const now = Date.now();
		const resetAt = now + 2 * 60 * 60 * 1000;
		await withPiAuthAsync({
			antigravity: {
				type: "oauth",
				email: "flash@example.com",
				accounts: [{
					email: "flash@example.com",
					refreshToken: "refresh-flash",
					projectId: "project-flash",
					enabled: true,
					cachedQuotaUpdatedAt: now,
					cachedQuota: {
						"gemini-flash": { remainingFraction: 0.73, resetTime: new Date(resetAt).toISOString() },
					},
				}],
				activeIndex: 0,
			},
		}, async () => {
			const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel);
			if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

			const status = await queryModelUsageStatus(descriptor);

			assert.equal(status?.provider, "google-antigravity");
			assert.equal(status?.accountEmail, "Σ");
			assert.equal(status?.hourly?.remainingPercent, 73);
			assert.equal(status?.weekly, undefined);
			await assert.rejects(queryModelUsageStatus(descriptor, { freshOnly: true }), /Live quota availability/u);
		});
	});

	it("falls back to cached shared Flash quota when live Antigravity response omits the current route", async () => {
		const oldFetch = globalThis.fetch;
		const now = Date.now();
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			if (String(input) !== "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels") {
				throw new Error(`Unexpected fetch: ${String(input)}`);
			}
			return Response.json({
				models: {
					"gemini-3-flash": {
						quotaInfo: {
							remainingFraction: 0.1,
							resetTime: new Date(now + 60 * 60 * 1000).toISOString(),
						},
					},
				},
			});
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				antigravity: {
					type: "oauth",
					access: `live-access|project-live`,
					expires: now + 60 * 60 * 1000,
					accounts: [{
						email: "flash@example.com",
						refreshToken: "refresh-flash",
						enabled: true,
						cachedQuotaUpdatedAt: now,
						cachedQuota: {
							"gemini-flash": {
								remainingFraction: 0.73,
								resetTime: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
							},
						},
					}],
					activeIndex: 0,
				},
			}, async () => {
				const descriptor = modelUsageDescriptor(
					{ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel,
					"xhigh",
				);
				if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

				const status = await queryModelUsageStatus(descriptor);

				assert.equal(status?.hourly?.remainingPercent, 73);
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	it("uses the configured Pi agent directory when loading Antigravity quota auth", async () => {
		const previousNodeEnv = process.env.NODE_ENV;
		const previousTestAuthPath = process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "pix-agent-dir-"));
		const now = Date.now();
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
			antigravity: {
				type: "oauth",
				email: "agent-dir@example.com",
				accounts: [{
					email: "agent-dir@example.com",
					refreshToken: "refresh-agent-dir",
					projectId: "project-agent-dir",
					enabled: true,
					cachedQuotaUpdatedAt: now,
					cachedQuota: {
						claude: { remainingFraction: 0.61, resetTime: new Date(now + 3 * 60 * 60 * 1000).toISOString() },
					},
				}],
				activeIndex: 0,
			},
		}), "utf8");
		process.env.NODE_ENV = "development";
		delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		process.env.PI_CODING_AGENT_DIR = agentDir;

		try {
			const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "antigravity-claude-opus-4-6-thinking" } as SessionModel);
			if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

			const status = await queryModelUsageStatus(descriptor);

			assert.equal(status?.hourly?.remainingPercent, 61);
		} finally {
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
			if (previousTestAuthPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
			else process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = previousTestAuthPath;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("uses Antigravity OAuth client environment credentials for quota refresh", async () => {
		const previousClientId = process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID;
		const previousClientSecret = process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
		const oldFetch = globalThis.fetch;
		let tokenRequests = 0;
		let quotaRequests = 0;
		process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID = "desktop-client-id";
		process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = "desktop-client-secret";
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				tokenRequests += 1;
				assert.equal(String(init?.body), "client_id=desktop-client-id&refresh_token=refresh-env&grant_type=refresh_token&client_secret=desktop-client-secret");
				return Response.json({ access_token: "refreshed-access" });
			}
			if (url === "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary") {
				quotaRequests += 1;
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("Authorization"), "Bearer refreshed-access");
				assert.match(headers.get("User-Agent") ?? "", /^antigravity\/cli\/1\.1\.24 /u);
				assert.equal(headers.get("Accept-Encoding"), "gzip");
				assert.equal(String(init?.body), JSON.stringify({ project: "project-env" }));
				return Response.json({
					groups: [{
						buckets: [{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.84,
							resetTime: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString(),
						}],
					}],
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				antigravity: {
					type: "oauth",
					email: "env@example.com",
					accounts: [{
						email: "env@example.com",
						refreshToken: "refresh-env",
						projectId: "project-env",
						enabled: true,
					}],
					activeIndex: 0,
				},
			}, async () => {
				const descriptor = modelUsageDescriptor({ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel);
				if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

				const status = await queryModelUsageStatus(descriptor);

				assert.equal(status?.weekly?.remainingPercent, 84);
				assert.equal(status?.hourly, undefined);
				assert.equal(tokenRequests, 1);
				assert.equal(quotaRequests, 1);
			});
		} finally {
			globalThis.fetch = oldFetch;
			if (previousClientId === undefined) delete process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID;
			else process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_ID = previousClientId;
			if (previousClientSecret === undefined) delete process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET;
			else process.env.PI_ANTIGRAVITY_GOOGLE_CLIENT_SECRET = previousClientSecret;
		}
	});

	it("refreshes a rejected active Antigravity access token and keeps its live project id", async () => {
		const oldFetch = globalThis.fetch;
		let quotaRequests = 0;
		let tokenRequests = 0;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = String(input);
			if (url === "https://oauth2.googleapis.com/token") {
				tokenRequests += 1;
				return Response.json({ access_token: "refreshed-access" });
			}
			if (url.endsWith("/v1internal:retrieveUserQuotaSummary")) {
				quotaRequests += 1;
				const headers = new Headers(init?.headers);
				assert.equal(String(init?.body), JSON.stringify({ project: "live-project" }));
				if (headers.get("Authorization") === "Bearer stale-access") {
					return new Response("expired", { status: 401 });
				}
				assert.equal(headers.get("Authorization"), "Bearer refreshed-access");
				return Response.json({
					groups: [{
						buckets: [{
							bucketId: "gemini-weekly",
							window: "weekly",
							remainingFraction: 0.66,
							resetTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
						}],
					}],
				});
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		try {
			await withPiAuthAsync({
				antigravity: {
					type: "oauth",
					access: `stale-access|live-project`,
					expires: Date.now() + 60 * 60 * 1000,
					oauthClient: { clientId: "stored-client-id" },
					accounts: [{
						email: "active@example.com",
						refreshToken: "refresh-active",
						enabled: true,
					}],
					activeIndex: 0,
				},
			}, async () => {
				const descriptor = modelUsageDescriptor(
					{ provider: "antigravity", id: "antigravity-gemini-3.8-flash" } as SessionModel,
					"xhigh",
				);
				if (descriptor?.kind !== "google-antigravity") throw new Error("Expected Google Antigravity descriptor");

				const status = await queryModelUsageStatus(descriptor);

				assert.equal(status?.weekly?.remainingPercent, 66);
				assert.equal(status?.hourly, undefined);
				assert.equal(quotaRequests, 3);
				assert.equal(tokenRequests, 1);
			});
		} finally {
			globalThis.fetch = oldFetch;
		}
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
	it("returns empty labels and no descriptor when quota bucket is unavailable", () => {
		assert.equal(formatModelUsageStatusLabel(undefined), "");
		assert.equal(modelUsageRemainingPercent(undefined), undefined);
		withPiAuth({}, () => {
			assert.equal(modelUsageDescriptor({ provider: "antigravity", id: "unknown-model" } as SessionModel), undefined);
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

async function withPiAuthAsync(auth: unknown, run: (authPath: string) => Promise<void>): Promise<void> {
	const previousNodeEnv = process.env.NODE_ENV;
	const previousAuthPath = process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
	const agentDir = mkdtempSync(join(tmpdir(), "pix-agent-"));
	const authPath = join(agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify(auth), "utf8");
	process.env.NODE_ENV = "test";
	process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = authPath;
	try {
		await run(authPath);
	} finally {
		if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previousNodeEnv;
		if (previousAuthPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
		else process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH = previousAuthPath;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

function testJwt(payload: Record<string, unknown>): string {
	const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
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
