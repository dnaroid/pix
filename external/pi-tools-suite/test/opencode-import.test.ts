import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import opencodeImport, {
	formatOpencodeImportResult,
	importOpencodeAccounts,
	notificationLevel,
	parseOpencodeImportCommandArgs,
} from "../src/opencode-import/index.js";

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

	test("routes OpenAI API keys separately from Codex OAuth", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const authPath = path.join(dir, "pi-auth.json");

		writeJson(sourcePath, { openai: { type: "api", key: "openai-key" } });
		const result = await importOpencodeAccounts({ sourcePath, authPath, skipAntigravity: true });

		expect(readJson(authPath).openai).toEqual({ type: "api_key", key: "openai-key" });
		expect(readJson(authPath)["openai-codex"]).toBeUndefined();
		expect(result.providers.find((provider) => provider.sourceProvider === "openai")).toMatchObject({
			targetProvider: "openai",
			status: "imported",
		});
	});

	test("rejects incomplete OAuth credentials instead of writing partial auth", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const authPath = path.join(dir, "pi-auth.json");

		writeJson(sourcePath, { openai: { type: "oauth", access: "access-only", expires: 123 } });
		const result = await importOpencodeAccounts({ sourcePath, authPath, skipAntigravity: true });

		expect(fs.existsSync(authPath)).toBe(false);
		expect(result.providers.find((provider) => provider.sourceProvider === "openai")).toMatchObject({
			targetProvider: "openai-codex",
			status: "invalid-source",
		});
	});

	test("reads OPENCODE_AUTH_CONTENT and honors the canonical Pi agent directory", async () => {
		const dir = tempDir();
		const previousContent = process.env.OPENCODE_AUTH_CONTENT;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "api", key: "from-env" } });
		process.env.PI_CODING_AGENT_DIR = path.join(dir, "custom-agent");

		try {
			const result = await importOpencodeAccounts({ skipAntigravity: true });
			expect(result.sourcePath).toBe("OPENCODE_AUTH_CONTENT");
			expect(result.authPath).toBe(path.join(dir, "custom-agent", "auth.json"));
			expect(readJson(result.authPath).openai.key).toBe("from-env");
		} finally {
			if (previousContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
			else process.env.OPENCODE_AUTH_CONTENT = previousContent;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
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

	test("describes no-write results without claiming that auth was written", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const authPath = path.join(dir, "pi-auth.json");
		writeJson(sourcePath, { openai: { type: "api", key: "same-key" } });
		writeJson(authPath, { openai: { type: "api_key", key: "same-key" } });

		const result = await importOpencodeAccounts({ sourcePath, authPath, skipAntigravity: true });
		const message = formatOpencodeImportResult(result);

		expect(result.wroteAuth).toBe(false);
		expect(message).toContain("OpenCode credential check");
		expect(message).not.toContain("wrote to");
		expect(notificationLevel(result)).toBe("info");
	});

	test("reloads resources only after credentials are written", async () => {
		const dir = tempDir();
		const sourcePath = path.join(dir, "opencode-auth.json");
		const authPath = path.join(dir, "pi-auth.json");
		writeJson(sourcePath, { openai: { type: "api", key: "reload-key" } });

		let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
		opencodeImport({
			registerCommand: (_name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => {
				handler = command.handler;
			},
		} as any);
		let reloadCount = 0;
		const notifications: Array<{ message: string; level: string }> = [];
		const ctx = {
			ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
			reload: async () => {
				reloadCount += 1;
			},
		};
		const args = `--path ${sourcePath} --auth-path ${authPath} --skip-antigravity`;

		await handler!(args, ctx);
		expect(reloadCount).toBe(1);
		expect(notifications[notifications.length - 1]?.level).toBe("info");

		await handler!(args, ctx);
		expect(reloadCount).toBe(1);
		expect(notifications[notifications.length - 1]?.message).toContain("already imported");
	});
});
