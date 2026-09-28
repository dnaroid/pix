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
		return selectClaudeCodeUsageToken(undefined, () => readRawCredential(process.env.PI_TOOLS_SUITE_TEST_CLAUDE_AUTH_PATH));
	}

	// The adapter's Claude subprocess deliberately allows only CLAUDE_CONFIG_DIR
	// and a small set of ordinary host variables through. In particular, Pi's
	// ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN never reach this route.
	const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
	return selectClaudeCodeUsageToken(
		process.platform === "darwin"
			? () => readKeychainCredential(claudeCodeKeychainService(configDir))
			: undefined,
		() => readRawCredential(join(configDir || join(homedir(), ".claude"), ".credentials.json")),
	);
}

export function claudeCodeKeychainService(configDir?: string): string {
	if (!configDir) return "Claude Code-credentials";
	const hash = createHash("sha256").update(configDir.replace(/\/+$/u, "")).digest("hex").slice(0, 8);
	return `Claude Code-credentials-${hash}`;
}

/**
 * Local-only Claude Code credential probe: true when a usable (unexpired)
 * Claude Code token is readable. Performs no provider network I/O, so quota
 * polling may retry at a faster cadence while this stays false — each retry
 * only re-reads the Keychain/credentials file until Claude Code refreshes
 * its login.
 */
export async function claudeCodeCredentialAvailable(): Promise<boolean> {
	return (await readClaudeCodeUsageToken()) !== undefined;
}

/**
 * Pick the first usable Claude Code login token. A Keychain entry that is
 * present but invalid or expired must not mask a valid `.credentials.json`
 * fallback — Claude Code itself keeps both locations in sync only after it
 * refreshes its login, so the fresher copy can be either one. Both readers are
 * local-only and never write or refresh credentials.
 */
export async function selectClaudeCodeUsageToken(
	readKeychain: (() => Promise<string | undefined>) | undefined,
	readFile: () => Promise<string | undefined>,
): Promise<string | undefined> {
	if (readKeychain) {
		// An unavailable/locked Keychain is not an error here: fall back to the
		// credential file exactly like Claude Code does.
		const keychain = await readKeychain().catch(() => undefined);
		const keychainToken = keychain === undefined ? undefined : tokenFromClaudeCredential(keychain);
		if (keychainToken) return keychainToken;
	}
	const file = await readFile().catch(() => undefined);
	return file === undefined ? undefined : tokenFromClaudeCredential(file);
}

async function readKeychainCredential(service: string): Promise<string | undefined> {
	const { stdout } = await execFileAsync(
		"/usr/bin/security",
		["find-generic-password", "-s", service, "-w"],
		{ timeout: 3_000, maxBuffer: 64 * 1024 },
	);
	return stdout;
}

async function readRawCredential(path: string | undefined): Promise<string | undefined> {
	if (!path) return undefined;
	try {
		return await readFile(path, "utf8");
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
