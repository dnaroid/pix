import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { importOpencodeAccounts, parseOpencodeImportCommandArgs } from "../src/opencode-import/index.js";

const tempDirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-import-test-"));
	tempDirs.push(dir);
	return dir;
}

function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("opencode import", () => {
	test("imports opencode auth.json credentials and Antigravity accounts", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const antigravitySourcePath = path.join(dir, "antigravity-accounts.json");
		const authPath = path.join(dir, "pi-auth.json");

		writeJson(sourcePath, {
			openai: { type: "oauth", access: "openai-access", refresh: "openai-refresh", expires: 123 },
			"github-copilot": { type: "oauth", access: "copilot-access", refresh: "copilot-refresh", expires: 456 },
			"zai-coding-plan": { type: "api", key: "zai-key" },
		});
		writeJson(antigravitySourcePath, {
			version: 1,
			activeIndex: 1,
			accounts: [
				{ email: "first@example.com", refreshToken: "refresh-0", projectId: "project-0" },
				{ email: "second@example.com", refreshToken: "refresh-1", projectId: "project-1" },
			],
		});

		const result = await importOpencodeAccounts({ sourcePath, antigravitySourcePath, authPath });
		const auth = readJson(authPath);

		expect(result.wroteAuth).toBe(true);
		expect(auth["openai-codex"]).toMatchObject({ type: "oauth", access: "openai-access", refresh: "openai-refresh", expires: 123 });
		expect(auth["github-copilot"]).toMatchObject({ type: "oauth", access: "copilot-access", refresh: "copilot-refresh", expires: 456 });
		expect(auth.zai).toEqual({ type: "api_key", key: "zai-key" });
		expect(auth.antigravity).toMatchObject({ type: "oauth", email: "second@example.com", activeIndex: 1 });
		expect(auth.antigravity.refresh).toBe("refresh-1|project-1");
		expect(auth.antigravity.accounts).toHaveLength(2);
	});

	test("keeps existing Pi auth unless force is passed", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const authPath = path.join(dir, "pi-auth.json");

		writeJson(sourcePath, { "zai-coding-plan": { type: "api", key: "new-key" } });
		writeJson(authPath, { zai: { type: "api_key", key: "existing-key" } });

		const skipped = await importOpencodeAccounts({ sourcePath, authPath, skipAntigravity: true });
		expect(readJson(authPath).zai.key).toBe("existing-key");
		expect(skipped.providers.find((provider) => provider.targetProvider === "zai")?.status).toBe("auth-exists-use-force");

		const imported = await importOpencodeAccounts({ sourcePath, authPath, skipAntigravity: true, overwrite: true });
		expect(readJson(authPath).zai.key).toBe("new-key");
		expect(imported.providers.find((provider) => provider.targetProvider === "zai")?.status).toBe("imported");
	});

	test("preserves existing Antigravity OAuth client credentials when force-importing accounts", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const antigravitySourcePath = path.join(dir, "antigravity-accounts.json");
		const authPath = path.join(dir, "pi-auth.json");
		const oauthClient = { clientId: "existing-client-id", clientSecret: "existing-client-secret" };

		writeJson(sourcePath, {});
		writeJson(authPath, {
			antigravity: {
				type: "oauth",
				refresh: "old-refresh|old-project",
				access: "old-access|old-project",
				expires: 123,
				email: "old@example.com",
				oauthClient,
			},
		});
		writeJson(antigravitySourcePath, {
			version: 1,
			activeIndex: 0,
			accounts: [{ email: "new@example.com", refreshToken: "new-refresh", projectId: "new-project" }],
		});

		const result = await importOpencodeAccounts({ sourcePath, antigravitySourcePath, authPath, overwrite: true });
		const auth = readJson(authPath);

		expect(result.antigravity?.imported).toBe(true);
		expect(auth.antigravity).toMatchObject({
			type: "oauth",
			refresh: "new-refresh|new-project",
			email: "new@example.com",
			oauthClient,
		});
	});

	test("parses opencode import command arguments", () => {
		expect(parseOpencodeImportCommandArgs("--path /tmp/auth.json --auth-path /tmp/pi-auth.json --antigravity-path /tmp/ag.json --antigravity-index 2 --force")).toEqual({
			sourcePath: "/tmp/auth.json",
			authPath: "/tmp/pi-auth.json",
			antigravitySourcePath: "/tmp/ag.json",
			antigravityAccountIndex: 2,
			overwrite: true,
		});
	});
});
