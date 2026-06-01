import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PROJECT_ID, PROVIDER_ID } from "./constants";
import type { OpencodeAntigravityAccount, OpencodeAntigravityImportResult, OpencodeAntigravityStorage, PiAuthCredential, PiAuthData } from "./types";

export function splitRefresh(refresh: string): { refreshToken: string; projectId?: string; managedProjectId?: string } {
	const [refreshToken = "", projectId = "", managedProjectId = ""] = refresh.split("|");
	return {
		refreshToken: refreshToken || refresh,
		projectId: projectId || undefined,
		managedProjectId: managedProjectId || undefined,
	};
}

export function joinRefresh(refreshToken: string, projectId?: string, managedProjectId?: string): string {
	const base = `${refreshToken}|${projectId ?? ""}`;
	return managedProjectId ? `${base}|${managedProjectId}` : base;
}

export function getEffectiveProjectId(refresh: string): string | undefined {
	const { projectId, managedProjectId } = splitRefresh(refresh);
	return projectId || managedProjectId;
}

export function encodeApiKey(access: string, projectId?: string): string {
	return projectId ? `${access}|${projectId}` : access;
}

export function decodeApiKey(apiKey: string): { access: string; projectId?: string } {
	const [access = apiKey, projectId = ""] = apiKey.split("|");
	return { access, projectId: projectId || undefined };
}

function getDefaultOpencodeAccountsPath(): string {
	const configDir = process.env.OPENCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode");
	return join(configDir, "antigravity-accounts.json");
}

export function getPiAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(path, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
		throw error;
	}
}

export async function writeJsonFileSecure(path: string, data: unknown): Promise<void> {
	await fs.mkdir(dirname(path), { recursive: true });
	await fs.writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await fs.chmod(path, 0o600).catch(() => undefined);
}

export function getStoredAccounts(credential?: PiAuthCredential): OpencodeAntigravityAccount[] {
	return Array.isArray(credential?.accounts) ? credential.accounts.filter((account) => account.enabled !== false && account.refreshToken) : [];
}

export function clampAccountIndex(index: unknown, accountCount: number): number {
	if (!Number.isInteger(index) || accountCount <= 0) return 0;
	return Math.max(0, Math.min(index as number, accountCount - 1));
}

export function getAccountProjectId(account: OpencodeAntigravityAccount): string {
	return account.projectId || account.managedProjectId || DEFAULT_PROJECT_ID;
}

export function accountFromCredential(credential?: PiAuthCredential): OpencodeAntigravityAccount | undefined {
	if (credential?.type !== "oauth" || !credential.refresh) return undefined;
	const refresh = splitRefresh(credential.refresh);
	if (!refresh.refreshToken) return undefined;
	return {
		email: credential.email,
		refreshToken: refresh.refreshToken,
		projectId: refresh.projectId || refresh.managedProjectId || DEFAULT_PROJECT_ID,
		managedProjectId: refresh.managedProjectId,
		enabled: true,
	};
}

export function findMatchingAccountIndex(accounts: OpencodeAntigravityAccount[], account: OpencodeAntigravityAccount): number {
	const email = account.email?.toLowerCase();
	if (email) {
		const byEmail = accounts.findIndex((existing) => existing.email?.toLowerCase() === email);
		if (byEmail >= 0) return byEmail;
	}
	if (account.refreshToken) {
		return accounts.findIndex((existing) => existing.refreshToken === account.refreshToken);
	}
	return -1;
}

function selectOpencodeAccount(
	storage: OpencodeAntigravityStorage,
	options: { accountIndex?: number; email?: string },
): { account: OpencodeAntigravityAccount; index: number; count: number } | undefined {
	const accounts = storage.accounts?.filter((account) => account && typeof account.refreshToken === "string" && account.refreshToken) ?? [];
	if (accounts.length === 0) return undefined;

	if (options.email) {
		const email = options.email.toLowerCase();
		const index = accounts.findIndex((account) => account.email?.toLowerCase() === email);
		return index >= 0 ? { account: accounts[index], index, count: accounts.length } : undefined;
	}

	if (typeof options.accountIndex === "number") {
		const index = options.accountIndex;
		return index >= 0 && index < accounts.length ? { account: accounts[index], index, count: accounts.length } : undefined;
	}

	const activeIndex = Number.isInteger(storage.activeIndex) ? Math.max(0, Math.min(storage.activeIndex ?? 0, accounts.length - 1)) : 0;
	const activeAccount = accounts[activeIndex];
	if (activeAccount?.enabled !== false) return { account: activeAccount, index: activeIndex, count: accounts.length };

	const firstEnabledIndex = accounts.findIndex((account) => account.enabled !== false);
	return firstEnabledIndex >= 0 ? { account: accounts[firstEnabledIndex], index: firstEnabledIndex, count: accounts.length } : undefined;
}

export async function importOpencodeAntigravityAccount(options: {
	sourcePath?: string;
	authPath?: string;
	overwrite?: boolean;
	accountIndex?: number;
	email?: string;
} = {}): Promise<OpencodeAntigravityImportResult> {
	const sourcePath = options.sourcePath ?? getDefaultOpencodeAccountsPath();
	const authPath = options.authPath ?? getPiAuthPath();
	const storage = await readJsonFile<OpencodeAntigravityStorage | null>(sourcePath, null);
	if (!storage || !Array.isArray(storage.accounts)) {
		return { imported: false, reason: "source-missing-or-invalid", sourcePath, authPath };
	}

	const selected = selectOpencodeAccount(storage, options);
	if (!selected) {
		return { imported: false, reason: "matching-account-not-found", sourcePath, authPath, accountCount: storage.accounts.length };
	}

	const piAuth = await readJsonFile<PiAuthData>(authPath, {});
	const existing = piAuth[PROVIDER_ID];
	const refresh = joinRefresh(
		selected.account.refreshToken!,
		selected.account.projectId || selected.account.managedProjectId || DEFAULT_PROJECT_ID,
		selected.account.managedProjectId,
	);

	if (existing?.type === "oauth" && existing.refresh === refresh) {
		return {
			imported: false,
			reason: "already-imported",
			sourcePath,
			authPath,
			email: selected.account.email,
			accountIndex: selected.index,
			accountCount: selected.count,
		};
	}
	if (existing && !options.overwrite) {
		return {
			imported: false,
			reason: "auth-exists-use-force",
			sourcePath,
			authPath,
			email: selected.account.email,
			accountIndex: selected.index,
			accountCount: selected.count,
		};
	}

	piAuth[PROVIDER_ID] = {
		type: "oauth",
		refresh,
		access: "",
		expires: 0,
		email: selected.account.email,
		accounts: storage.accounts.filter((account) => account.enabled !== false && account.refreshToken),
		activeIndex: selected.index,
	};
	await writeJsonFileSecure(authPath, piAuth);

	return {
		imported: true,
		sourcePath,
		authPath,
		email: selected.account.email,
		accountIndex: selected.index,
		accountCount: selected.count,
		overwroteExisting: !!existing,
	};
}
