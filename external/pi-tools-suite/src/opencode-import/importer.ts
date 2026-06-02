import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPiAuthPath, importOpencodeAntigravityAccount, readJsonFile, writeJsonFileSecure } from "../antigravity-auth/auth-store";

export type OpencodeAuthCredential = {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	key?: string;
	[key: string]: unknown;
};

export type PiAuthCredential = OpencodeAuthCredential;
export type PiAuthData = Record<string, PiAuthCredential | undefined>;
export type OpencodeAuthData = Record<string, OpencodeAuthCredential | undefined>;

export type OpencodeProviderImportStatus = "imported" | "already-imported" | "auth-exists-use-force" | "source-missing" | "target-set-from-other-source" | "invalid-source";

export type OpencodeProviderImportResult = {
	label: string;
	sourceProvider: string;
	targetProvider: string;
	status: OpencodeProviderImportStatus;
};

export type OpencodeImportResult = {
	sourcePath: string;
	antigravitySourcePath?: string;
	authPath: string;
	providers: OpencodeProviderImportResult[];
	antigravity?: {
		imported: boolean;
		reason?: string;
		email?: string;
		accountIndex?: number;
		accountCount?: number;
		overwroteExisting?: boolean;
	};
	wroteAuth: boolean;
};

export type OpencodeImportOptions = {
	sourcePath?: string;
	authPath?: string;
	antigravitySourcePath?: string;
	overwrite?: boolean;
	skipAuthJson?: boolean;
	skipAntigravity?: boolean;
	antigravityAccountIndex?: number;
	antigravityEmail?: string;
};

type Mapping = {
	label: string;
	sourceProvider: string;
	targetProvider: string;
	transform: (credential: OpencodeAuthCredential) => PiAuthCredential | undefined;
};

const AUTH_JSON_MAPPINGS: Mapping[] = [
	{
		label: "OpenAI Codex",
		sourceProvider: "openai",
		targetProvider: "openai-codex",
		transform: transformOAuthCredential,
	},
	{
		label: "GitHub Copilot",
		sourceProvider: "github-copilot",
		targetProvider: "github-copilot",
		transform: transformOAuthCredential,
	},
	{
		label: "Z.ai",
		sourceProvider: "zai-coding-plan",
		targetProvider: "zai",
		transform: transformApiKeyCredential,
	},
	{
		label: "Zhipu/Z.ai",
		sourceProvider: "zhipuai-coding-plan",
		targetProvider: "zai",
		transform: transformApiKeyCredential,
	},
];

export function getDefaultOpencodeAuthPath(): string {
	const dataDir = process.env.OPENCODE_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode");
	return join(dataDir, "auth.json");
}

function transformOAuthCredential(credential: OpencodeAuthCredential): PiAuthCredential | undefined {
	if (!credential.access && !credential.refresh) return undefined;
	return { ...credential, type: "oauth" };
}

function transformApiKeyCredential(credential: OpencodeAuthCredential): PiAuthCredential | undefined {
	if (!credential.key) return undefined;
	return { ...credential, type: "api_key", key: credential.key };
}

function sameCredential(a: PiAuthCredential | undefined, b: PiAuthCredential | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function providerResult(mapping: Mapping, status: OpencodeProviderImportStatus): OpencodeProviderImportResult {
	return {
		label: mapping.label,
		sourceProvider: mapping.sourceProvider,
		targetProvider: mapping.targetProvider,
		status,
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
}

export async function importOpencodeAccounts(options: OpencodeImportOptions = {}): Promise<OpencodeImportResult> {
	const sourcePath = options.sourcePath ?? getDefaultOpencodeAuthPath();
	const authPath = options.authPath ?? getPiAuthPath();
	const result: OpencodeImportResult = {
		sourcePath,
		authPath,
		providers: [],
		wroteAuth: false,
	};
	if (options.antigravitySourcePath) result.antigravitySourcePath = options.antigravitySourcePath;

	let piAuth = await readJsonFile<PiAuthData>(authPath, {});
	const changedTargets = new Set<string>();

	if (!options.skipAuthJson) {
		const sourceExists = await pathExists(sourcePath);
		const opencodeAuth = sourceExists ? await readJsonFile<OpencodeAuthData>(sourcePath, {}) : {};

		for (const mapping of AUTH_JSON_MAPPINGS) {
			const sourceCredential = opencodeAuth[mapping.sourceProvider];
			if (!sourceCredential) {
				result.providers.push(providerResult(mapping, "source-missing"));
				continue;
			}

			if (changedTargets.has(mapping.targetProvider)) {
				result.providers.push(providerResult(mapping, "target-set-from-other-source"));
				continue;
			}

			const nextCredential = mapping.transform(sourceCredential);
			if (!nextCredential) {
				result.providers.push(providerResult(mapping, "invalid-source"));
				continue;
			}

			const existingCredential = piAuth[mapping.targetProvider];
			if (sameCredential(existingCredential, nextCredential)) {
				result.providers.push(providerResult(mapping, "already-imported"));
				changedTargets.add(mapping.targetProvider);
				continue;
			}

			if (existingCredential && !options.overwrite) {
				result.providers.push(providerResult(mapping, "auth-exists-use-force"));
				changedTargets.add(mapping.targetProvider);
				continue;
			}

			piAuth = { ...piAuth, [mapping.targetProvider]: nextCredential };
			changedTargets.add(mapping.targetProvider);
			result.providers.push(providerResult(mapping, "imported"));
		}

		if (result.providers.some((provider) => provider.status === "imported")) {
			await writeJsonFileSecure(authPath, piAuth);
			result.wroteAuth = true;
		}
	}

	if (!options.skipAntigravity) {
		const antigravity = await importOpencodeAntigravityAccount({
			sourcePath: options.antigravitySourcePath,
			authPath,
			overwrite: options.overwrite,
			accountIndex: options.antigravityAccountIndex,
			email: options.antigravityEmail,
		});
		const antigravityResult: NonNullable<OpencodeImportResult["antigravity"]> = {
			imported: antigravity.imported,
		};
		if (antigravity.reason) antigravityResult.reason = antigravity.reason;
		if (antigravity.email) antigravityResult.email = antigravity.email;
		if (typeof antigravity.accountIndex === "number") antigravityResult.accountIndex = antigravity.accountIndex;
		if (typeof antigravity.accountCount === "number") antigravityResult.accountCount = antigravity.accountCount;
		if (typeof antigravity.overwroteExisting === "boolean") antigravityResult.overwroteExisting = antigravity.overwroteExisting;
		result.antigravity = antigravityResult;
		result.antigravitySourcePath = antigravity.sourcePath;
		result.wroteAuth ||= antigravity.imported;
	}

	return result;
}
