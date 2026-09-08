import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RECOVERY_CORPUS_VERSION } from "./recovery-corpus.js";
import { RECOVERY_VALIDATOR_VERSION } from "./recovery-validation.js";

export const RECOVERY_REPORT_VERSION = 2;
export const RECOVERY_HARNESS_VERSION = 2;

export type RecoveryRunIdentity = {
	reportVersion: number;
	harnessVersion: number;
	validatorVersion: number;
	corpusVersion: number;
	git: { head: string | null; dirty: boolean | null };
	testedPackage: {
		entrypoint: "index.ts";
		entrypointSha256: string;
		sourceSha256: string;
		sourceFileCount: number;
	};
	hashes: {
		harnessRunnerSha256: string;
		recoveryRunnerSha256: string;
		validatorSha256: string;
		corpusSha256: string;
	};
	sdk: { piCodingAgentVersion: string | null };
	runtime: {
		command: "pi";
		node: string;
		bun: string | null;
		platform: string;
		arch: string;
	};
	effectiveConfig: {
		contextGatewayMode: "observe";
		repoDiscoveryProfile: "native-compact";
		truncationMetadataNormalizer: true;
		piOffline: true;
		noSession: true;
		noExtensions: true;
		noSkills: true;
		noPromptTemplates: true;
		noThemes: true;
		noContextFiles: true;
	};
	armOrder: Array<{ model: string; provider: string; caseId: string }>;
};

function sha256File(filePath: string): string {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function walkRegularFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) stack.push(absolute);
			else if (entry.isFile()) files.push(absolute);
		}
	}
	return files.sort();
}

function hashPackageSource(packageRoot: string): { sha256: string; fileCount: number } {
	const files = [
		...walkRegularFiles(path.join(packageRoot, "src")),
		path.join(packageRoot, "index.ts"),
		path.join(packageRoot, "package.json"),
	].filter((filePath) => fs.existsSync(filePath)).sort();
	const hash = createHash("sha256");
	for (const filePath of files) {
		hash.update(path.relative(packageRoot, filePath).replaceAll(path.sep, "/"));
		hash.update("\0");
		hash.update(fs.readFileSync(filePath));
		hash.update("\0");
	}
	return { sha256: hash.digest("hex"), fileCount: files.length };
}

function gitText(repoRoot: string, args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

function sdkVersion(packageRoot: string): string | null {
	try {
		void packageRoot;
		const sdkEntrypoint = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const sdkPackageJson = path.resolve(path.dirname(sdkEntrypoint), "..", "package.json");
		const parsed = JSON.parse(fs.readFileSync(
			sdkPackageJson,
			"utf8",
		)) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

export function buildRecoveryRunIdentity(options: {
	packageRoot: string;
	repoRoot: string;
	models: readonly string[];
	caseIds: readonly string[];
}): RecoveryRunIdentity {
	const packageRoot = path.resolve(options.packageRoot);
	const repoRoot = path.resolve(options.repoRoot);
	const source = hashPackageSource(packageRoot);
	const evalRoot = path.join(packageRoot, "test", "evals");
	const head = gitText(repoRoot, ["rev-parse", "HEAD"]);
	const status = gitText(repoRoot, ["status", "--porcelain"]);

	return {
		reportVersion: RECOVERY_REPORT_VERSION,
		harnessVersion: RECOVERY_HARNESS_VERSION,
		validatorVersion: RECOVERY_VALIDATOR_VERSION,
		corpusVersion: RECOVERY_CORPUS_VERSION,
		git: { head, dirty: status === null ? null : status.length > 0 },
		testedPackage: {
			entrypoint: "index.ts",
			entrypointSha256: sha256File(path.join(packageRoot, "index.ts")),
			sourceSha256: source.sha256,
			sourceFileCount: source.fileCount,
		},
		hashes: {
			harnessRunnerSha256: sha256File(path.join(evalRoot, "harness", "runner.ts")),
			recoveryRunnerSha256: sha256File(path.join(evalRoot, "run-context-gateway-recovery.ts")),
			validatorSha256: sha256File(path.join(evalRoot, "recovery-validation.ts")),
			corpusSha256: sha256File(path.join(evalRoot, "recovery-corpus.ts")),
		},
		sdk: { piCodingAgentVersion: sdkVersion(packageRoot) },
		runtime: {
			command: "pi",
			node: process.version,
			bun: process.versions.bun ?? null,
			platform: process.platform,
			arch: process.arch,
		},
		effectiveConfig: {
			contextGatewayMode: "observe",
			repoDiscoveryProfile: "native-compact",
			truncationMetadataNormalizer: true,
			piOffline: true,
			noSession: true,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
		armOrder: options.models.flatMap((model) => options.caseIds.map((caseId) => ({
			model,
			provider: model.includes("/") ? model.slice(0, model.indexOf("/")) : "unknown",
			caseId,
		}))),
	};
}
