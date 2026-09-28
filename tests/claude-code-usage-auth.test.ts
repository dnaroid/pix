import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeCodeCredentialAvailable, selectClaudeCodeUsageToken } from "../src/app/model/claude-code-usage-auth.js";

function credential(expiresAt: number, accessToken = "sk-ant-oat-fixture"): string {
	return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
}

describe("claude code usage auth", () => {
	it("prefers a valid keychain token without reading the credentials file", async () => {
		let fileReads = 0;
		const token = await selectClaudeCodeUsageToken(
			async () => credential(Date.now() + 60_000, "sk-ant-oat-keychain"),
			() => {
				fileReads++;
				return Promise.resolve(credential(Date.now() + 60_000, "sk-ant-oat-file"));
			},
		);
		assert.equal(token, "sk-ant-oat-keychain");
		assert.equal(fileReads, 0);
	});

	it("falls back to the credentials file when the keychain entry exists but is expired, malformed, or not an OAuth token", async () => {
		const staleKeychainEntries = [
			credential(Date.now() - 1_000),
			"not JSON",
			JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-api-not-oauth", expiresAt: Date.now() + 60_000 } }),
			JSON.stringify({ otherLogin: true }),
		];
		for (const keychain of staleKeychainEntries) {
			const token = await selectClaudeCodeUsageToken(
				async () => keychain,
				async () => credential(Date.now() + 60_000, "sk-ant-oat-file"),
			);
			assert.equal(token, "sk-ant-oat-file");
		}
	});

	it("falls back to the credentials file when the keychain is unavailable", async () => {
		const token = await selectClaudeCodeUsageToken(
			() => Promise.reject(new Error("keychain locked")),
			async () => credential(Date.now() + 60_000, "sk-ant-oat-file"),
		);
		assert.equal(token, "sk-ant-oat-file");
	});

	it("uses the credentials file directly when no keychain reader exists", async () => {
		const token = await selectClaudeCodeUsageToken(
			undefined,
			async () => credential(Date.now() + 60_000, "sk-ant-oat-file"),
		);
		assert.equal(token, "sk-ant-oat-file");
	});

	it("returns undefined when no usable credential exists and never throws", async () => {
		assert.equal(
			await selectClaudeCodeUsageToken(
				async () => credential(Date.now() - 1_000),
				async () => credential(Date.now() - 1_000),
			),
			undefined,
		);
		assert.equal(
			await selectClaudeCodeUsageToken(undefined, () => Promise.reject(new Error("file gone"))),
			undefined,
		);
	});

	it("probes credential availability locally without provider I/O", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pix-claude-probe-"));
		const path = join(dir, ".credentials.json");
		const previousPath = process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH;
		const previousNodeEnv = process.env.NODE_ENV;
		const oldFetch = globalThis.fetch;
		let fetchCalls = 0;
		process.env.NODE_ENV = "test";
		process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH = path;
		globalThis.fetch = (async () => {
			fetchCalls++;
			throw new Error("no provider network expected");
		}) as typeof fetch;
		try {
			writeFileSync(path, credential(Date.now() + 60_000, "sk-ant-oat-probe"));
			assert.equal(await claudeCodeCredentialAvailable(), true);

			writeFileSync(path, credential(Date.now() - 60_000, "sk-ant-oat-probe"));
			assert.equal(await claudeCodeCredentialAvailable(), false);
			assert.equal(fetchCalls, 0);
		} finally {
			globalThis.fetch = oldFetch;
			if (previousPath === undefined) delete process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH;
			else process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH = previousPath;
			if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = previousNodeEnv;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
