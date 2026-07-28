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
	targetProvider: string | ((credential: OpencodeAuthCredential | undefined) => string);
	transform: (credential: OpencodeAuthCredential) => PiAuthCredential | undefined;
};

const AUTH_JSON_MAPPINGS: Mapping[] = [
	{
		label: "OpenAI",
		sourceProvider: "openai",
		targetProvider: (credential) => (isOAuthCredential(credential) ? "openai-codex" : "openai"),
		transform: transformOpenAiCredential,
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
	if (
		typeof credential.access !== "string" ||
		!credential.access ||
		typeof credential.refresh !== "string" ||
		!credential.refresh ||
		typeof credential.expires !== "number" ||
		!Number.isFinite(credential.expires)
	) {
		return undefined;
	}
	return { ...credential, type: "oauth" };
}

function transformApiKeyCredential(credential: OpencodeAuthCredential): PiAuthCredential | undefined {
	if (typeof credential.key !== "string" || !credential.key) return undefined;
	return { ...credential, type: "api_key", key: credential.key };
}

function isOAuthCredential(credential: OpencodeAuthCredential | undefined): boolean {
	return credential?.type === "oauth" || typeof credential?.access === "string" || typeof credential?.refresh === "string";
}

function transformOpenAiCredential(credential: OpencodeAuthCredential): PiAuthCredential | undefined {
	return isOAuthCredential(credential) ? transformOAuthCredential(credential) : transformApiKeyCredential(credential);
}

function sameCredential(a: PiAuthCredential | undefined, b: PiAuthCredential | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function targetProvider(mapping: Mapping, credential: OpencodeAuthCredential | undefined): string {
	return typeof mapping.targetProvider === "function" ? mapping.targetProvider(credential) : mapping.targetProvider;
}

function providerResult(mapping: Mapping, status: OpencodeProviderImportStatus, credential?: OpencodeAuthCredential): OpencodeProviderImportResult {
	return {
		label: mapping.label,
		sourceProvider: mapping.sourceProvider,
		targetProvider: targetProvider(mapping, credential),
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

async function readOpencodeAuth(sourcePath: string, environmentSource: string | undefined): Promise<OpencodeAuthData> {
	if (environmentSource !== undefined) return parseOpencodeAuthContent(environmentSource);
	if (!(await pathExists(sourcePath))) return {};
	return readJsonFile<OpencodeAuthData>(sourcePath, {});
}

export async function importOpencodeAccounts(options: OpencodeImportOptions = {}): Promise<OpencodeImportResult> {
	const environmentSource = options.sourcePath === undefined ? process.env.OPENCODE_AUTH_CONTENT : undefined;
	const sourcePath = options.sourcePath ?? (environmentSource !== undefined ? "OPENCODE_AUTH_CONTENT" : getDefaultOpencodeAuthPath());
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
		const opencodeAuth = await readOpencodeAuth(sourcePath, environmentSource);

		for (const mapping of AUTH_JSON_MAPPINGS) {
			const sourceCredential = opencodeAuth[mapping.sourceProvider];
			if (!sourceCredential) {
				result.providers.push(providerResult(mapping, "source-missing"));
				continue;
			}
			const resolvedTargetProvider = targetProvider(mapping, sourceCredential);

			if (changedTargets.has(resolvedTargetProvider)) {
				result.providers.push(providerResult(mapping, "target-set-from-other-source", sourceCredential));
				continue;
			}

			const nextCredential = mapping.transform(sourceCredential);
			if (!nextCredential) {
				result.providers.push(providerResult(mapping, "invalid-source", sourceCredential));
				continue;
			}

			const existingCredential = piAuth[resolvedTargetProvider];
			if (sameCredential(existingCredential, nextCredential)) {
				result.providers.push(providerResult(mapping, "already-imported", sourceCredential));
				changedTargets.add(resolvedTargetProvider);
				continue;
			}

			if (existingCredential && !options.overwrite) {
				result.providers.push(providerResult(mapping, "auth-exists-use-force", sourceCredential));
				changedTargets.add(resolvedTargetProvider);
				continue;
			}

			piAuth = { ...piAuth, [resolvedTargetProvider]: nextCredential };
			changedTargets.add(resolvedTargetProvider);
			result.providers.push(providerResult(mapping, "imported", sourceCredential));
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

function parseOpencodeAuthContent(content: string): OpencodeAuthData {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("OPENCODE_AUTH_CONTENT must contain a valid JSON object.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("OPENCODE_AUTH_CONTENT must contain a JSON object.");
	}
	return parsed as OpencodeAuthData;
}
