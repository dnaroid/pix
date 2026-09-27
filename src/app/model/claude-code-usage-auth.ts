import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Claude Code owns and refreshes this login; Pix only borrows a current token for quota polling. */
export async function readClaudeCodeUsageToken(): Promise<string | undefined> {
	// Tests never query the developer's environment, Keychain or actual Claude configuration.
	if (process.env.NODE_ENV === "test") {
		return readCredentialFile(process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH);
	}

	// The adapter's Claude subprocess deliberately allows only CLAUDE_CONFIG_DIR
	// and a small set of ordinary host variables through. In particular, Pi's
	// ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN never reach this route.
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
	if (process.platform === "darwin") {
		try {
			const { stdout } = await execFileAsync(
				"/usr/bin/security",
				["find-generic-password", "-s", claudeCodeKeychainService(configDir), "-w"],
				{ timeout: 3_000, maxBuffer: 64 * 1024 },
			);
			return tokenFromClaudeCredential(stdout);
		} catch {
			// Claude Code falls back to a local file when the Keychain is unavailable.
		}
	}
	return readCredentialFile(join(configDir || join(homedir(), ".claude"), ".credentials.json"));
}

export function claudeCodeKeychainService(configDir?: string): string {
	if (!configDir) return "Claude Code-credentials";
	const hash = createHash("sha256").update(configDir.replace(/\/+$/u, "")).digest("hex").slice(0, 8);
	return `Claude Code-credentials-${hash}`;
}

async function readCredentialFile(path: string | undefined): Promise<string | undefined> {
	if (!path) return undefined;
	try {
		return tokenFromClaudeCredential(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function tokenFromClaudeCredential(raw: string, now = Date.now()): string | undefined {
	try {
		const login = JSON.parse(raw)?.claudeAiOauth;
		const token = login?.accessToken;
		if (!isOAuthToken(token)) return undefined;
		if (typeof login.expiresAt !== "number" || !Number.isFinite(login.expiresAt) || login.expiresAt <= now) return undefined;
		return token;
	} catch {
		return undefined;
	}
}

function isOAuthToken(token: unknown): token is string {
	return typeof token === "string" && token.startsWith("sk-ant-oat");
}
