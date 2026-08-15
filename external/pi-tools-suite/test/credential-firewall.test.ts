import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import registerCredentialFirewall, { SecretRedactor, loadSecretFirewallConfig } from "../src/credential-firewall/index.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "credential-firewall-"));
}

class FakePi {
	handlers = new Map<string, any>();
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	async emit(name: string, event: any, ctx: any) { return await this.handlers.get(name)?.(event, ctx); }
}

describe("credential firewall redactor", () => {
	test("redacts high-confidence credentials with stable placeholders", () => {
		const redactor = new SecretRedactor();
		const token = `ghp_${"A".repeat(36)}`;
		const first = redactor.redactString(`token=${token} Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`);
		const second = redactor.redactString(`again ${token}`);

		expect(first.count).toBe(2);
		expect(first.value).not.toContain(token);
		expect(first.value).toContain("<SECRET:github_token:1>");
		expect(first.value).toContain("Authorization: Bearer <SECRET:bearer_token:1>");
		expect(second.value).toContain("<SECRET:github_token:1>");
	});

	test("redacts private keys, assignments, basic auth, and credential URLs", () => {
		const redactor = new SecretRedactor();
		const input = [
			"password=hunter2-secret",
			"Authorization: Basic dXNlcjpwYXNzd29yZA==",
			"postgres://alice:correcthorsebattery@db.example.test/app",
			"-----BEGIN PRIVATE KEY-----\nabc123456789\n-----END PRIVATE KEY-----",
		].join("\n");
		const result = redactor.redactString(input);

		expect(result.count).toBe(4);
		expect(result.value).not.toContain("hunter2-secret");
		expect(result.value).not.toContain("dXNlcjpwYXNzd29yZA==");
		expect(result.value).not.toContain("correcthorsebattery");
		expect(result.value).not.toContain("abc123456789");
	});

	test("redacts AWS access identifiers and AWS secret assignments", () => {
		const redactor = new SecretRedactor();
		const accessKey = `AKIA${"Q".repeat(16)}`;
		const secretKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
		const result = redactor.redactString(`AWS_ACCESS_KEY_ID=${accessKey}\nAWS_SECRET_ACCESS_KEY=${secretKey}`);

		expect(result.count).toBe(2);
		expect(result.value).not.toContain(accessKey);
		expect(result.value).not.toContain(secretKey);
		expect(result.value).toContain("<SECRET:aws_access_key:1>");
	});

	test("does not redact env references, placeholders, ordinary hashes, or opaque provider fields", () => {
		const redactor = new SecretRedactor();
		const hash = "a".repeat(64);
		const payload = {
			text: `api_key=$OPENAI_API_KEY\npassword=<SECRET:password:1>\nsha256=${hash}`,
			encrypted_content: `ghp_${"B".repeat(36)}`,
			signature: `sk-${"C".repeat(40)}`,
			image: { type: "image", data: `ghp_${"D".repeat(36)}` },
		};
		const result = redactor.redact(payload);

		expect(result.count).toBe(0);
		expect(result.value).toBe(payload);
	});

	test("walks nested provider payloads without mutating the original", () => {
		const redactor = new SecretRedactor();
		const token = `github_pat_${"e".repeat(40)}`;
		const payload = {
			messages: [{ role: "user", content: [{ type: "text", text: `credential ${token}` }] }],
		};
		const result = redactor.redact(payload);

		expect(result.count).toBe(1);
		expect(result.value).not.toBe(payload);
		expect((result.value as any).messages[0].content[0].text).toBe("credential <SECRET:github_token:1>");
		expect(payload.messages[0].content[0].text).toContain(token);
	});

	test("uses structured sensitive field names as a high-confidence signal", () => {
		const redactor = new SecretRedactor();
		const payload = {
			password: "correct-horse-battery-staple",
			config: {
				clientSecret: "internal-client-secret-value",
				access_token: "opaque-access-token-value",
				apiKey: "$OPENAI_API_KEY",
			},
		};
		const result = redactor.redact(payload);

		expect(result.count).toBe(3);
		expect((result.value as any).password).toBe("<SECRET:password:1>");
		expect((result.value as any).config.clientSecret).toContain("<SECRET:credential:");
		expect((result.value as any).config.access_token).toContain("<SECRET:credential:");
		expect((result.value as any).config.apiKey).toBe("$OPENAI_API_KEY");
	});
});

describe("credential firewall extension", () => {
	test("loads layered session-hygiene and notify settings", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "secretFirewall": { "notify": false } }`);
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "secretFirewall": { "sessionHygiene": false } }`);

		expect(loadSecretFirewallConfig(cwd, {}, homeDir)).toEqual({ sessionHygiene: false, notify: false });
		expect(loadSecretFirewallConfig(cwd, { PI_SECRET_FIREWALL_NOTIFY: "1" }, homeDir)).toEqual({ sessionHygiene: false, notify: true });
	});

	test("sanitizes outbound payloads and emits no secret value in the warning", async () => {
		const pi = new FakePi();
		registerCredentialFirewall(pi as any);
		const notifications: string[] = [];
		const token = `gho_${"F".repeat(36)}`;
		const result = await pi.emit(
			"before_provider_request",
			{ payload: { messages: [{ role: "user", content: `use ${token}` }] } },
			{ cwd: tempDir(), ui: { notify: (message: string) => notifications.push(message) } },
		);

		expect(result.messages[0].content).toContain("<SECRET:github_token:1>");
		expect(result.messages[0].content).not.toContain(token);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]).not.toContain(token);
	});

	test("session hygiene sanitizes tool results and completed messages", async () => {
		const pi = new FakePi();
		registerCredentialFirewall(pi as any);
		const cwd = tempDir();
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "secretFirewall": { "notify": false } }`);
		const token = `glpat-${"G".repeat(32)}`;
		const tool = await pi.emit("tool_result", { content: [{ type: "text", text: `token ${token}` }], details: { raw: token } }, { cwd });
		const message = await pi.emit("message_end", { message: { role: "user", content: `token ${token}` } }, { cwd });

		expect(tool.content[0].text).not.toContain(token);
		expect(tool.details.raw).not.toContain(token);
		expect(message.message.content).not.toContain(token);
	});
});
