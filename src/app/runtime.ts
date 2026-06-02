import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
	type EventBus,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type LoadExtensionsResult,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadPixConfig, resolveDefaultModelRef, type PixConfig } from "../config.js";
import { PI_FAVORITE_MODEL_REFS } from "./constants.js";
import { isThinkingLevel, parseModelRef, parseScopedModelRef } from "./model/model-ref.js";
import type { AppOptions, ScopedSessionModel, SessionModel } from "./types.js";

const BUNDLED_QUESTION_EXTENSION_NAME = "question";
const PI_TOOLS_SUITE_EXTENSION_NAME = "pi-tools-suite";
const BUNDLED_EXTENSIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
	"extensions",
);
const BUNDLED_QUESTION_EXTENSION_DIR = resolve(
	BUNDLED_EXTENSIONS_DIR,
	BUNDLED_QUESTION_EXTENSION_NAME,
);
const BUNDLED_SESSION_TITLE_EXTENSION_DIR = resolve(BUNDLED_EXTENSIONS_DIR, "session-title");
const BUNDLED_TERMINAL_BELL_EXTENSION_DIR = resolve(BUNDLED_EXTENSIONS_DIR, "terminal-bell");
const PI_TOOLS_SUITE_SOURCE_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
	"external",
	PI_TOOLS_SUITE_EXTENSION_NAME,
);
const BUNDLED_SKILLS_SOURCE_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../..",
	"skills",
);

export type PiToolsSuiteInstallAction = "installed" | "already-installed" | "existing-kept" | "missing-source";

export type PiToolsSuiteInstallResult = {
	action: PiToolsSuiteInstallAction;
	sourcePath: string;
	targetPath: string;
};

export type PiToolsSuiteInstallOptions = {
	agentDir?: string;
	sourcePath?: string;
	targetPath?: string;
};

export type BundledSkillsInstallAction = "installed" | "already-installed" | "missing-source";

export type BundledSkillsInstallResult = {
	action: BundledSkillsInstallAction;
	sourcePath: string;
	targetPath: string;
};

export type BundledSkillsInstallOptions = {
	homeDir?: string;
	sourcePath?: string;
	targetPath?: string;
};

export function bundledQuestionExtensionPath(): string {
	return BUNDLED_QUESTION_EXTENSION_DIR;
}

export function bundledSessionTitleExtensionPath(): string {
	return BUNDLED_SESSION_TITLE_EXTENSION_DIR;
}

export function bundledTerminalBellExtensionPath(): string {
	return BUNDLED_TERMINAL_BELL_EXTENSION_DIR;
}

export function piToolsSuiteExtensionSourcePath(): string {
	return PI_TOOLS_SUITE_SOURCE_DIR;
}

export function piToolsSuiteExtensionInstallPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extensions", PI_TOOLS_SUITE_EXTENSION_NAME);
}

export function bundledSkillsSourcePath(): string {
	return BUNDLED_SKILLS_SOURCE_DIR;
}

export function bundledSkillsInstallPath(homeDir = homedir()): string {
	return join(homeDir, ".agents", "skills");
}

export async function ensurePiToolsSuiteExtensionInstalled(options: PiToolsSuiteInstallOptions = {}): Promise<PiToolsSuiteInstallResult> {
	const sourcePath = resolve(options.sourcePath ?? piToolsSuiteExtensionSourcePath());
	const targetPath = resolve(options.targetPath ?? piToolsSuiteExtensionInstallPath(options.agentDir));

	if (!extensionEntryExists(sourcePath)) {
		return { action: "missing-source", sourcePath, targetPath };
	}

	await mkdir(dirname(targetPath), { recursive: true });
	const targetStat = await lstat(targetPath).catch(() => undefined);
	if (!targetStat) {
		await symlink(sourcePath, targetPath, extensionSymlinkType());
		return { action: "installed", sourcePath, targetPath };
	}

	if (targetStat.isSymbolicLink()) {
		const currentTarget = resolve(dirname(targetPath), await readlink(targetPath));
		if (await pathsReferToSameEntry(currentTarget, sourcePath)) {
			return { action: "already-installed", sourcePath, targetPath };
		}

		await rm(targetPath, { force: true });
		await symlink(sourcePath, targetPath, extensionSymlinkType());
		return { action: "installed", sourcePath, targetPath };
	}

	if (await pathsReferToSameEntry(targetPath, sourcePath)) {
		return { action: "already-installed", sourcePath, targetPath };
	}

	return { action: "existing-kept", sourcePath, targetPath };
}

export async function ensureBundledSkillsInstalled(options: BundledSkillsInstallOptions = {}): Promise<BundledSkillsInstallResult> {
	const sourcePath = resolve(options.sourcePath ?? bundledSkillsSourcePath());
	const targetPath = resolve(options.targetPath ?? bundledSkillsInstallPath(options.homeDir));
	const sourceStat = await lstat(sourcePath).catch(() => undefined);
	if (!sourceStat?.isDirectory()) {
		return { action: "missing-source", sourcePath, targetPath };
	}

	if (await pathsReferToSameEntry(sourcePath, targetPath)) {
		return { action: "already-installed", sourcePath, targetPath };
	}

	await mkdir(dirname(targetPath), { recursive: true });
	await cp(sourcePath, targetPath, { recursive: true, force: true });
	return { action: "installed", sourcePath, targetPath };
}

export function getBundledExtensionPaths(): string[] {
	return [
		bundledQuestionExtensionPath(),
		bundledSessionTitleExtensionPath(),
		bundledTerminalBellExtensionPath(),
	].filter(extensionEntryExists);
}

export function prioritizeBundledQuestionExtension(base: LoadExtensionsResult, questionExtensionPath = bundledQuestionExtensionPath()): LoadExtensionsResult {
	const bundledQuestionExtensions = base.extensions.filter((extension) => isBundledQuestionExtension(extension, questionExtensionPath));
	if (bundledQuestionExtensions.length === 0) return base;

	const bundledExtensionPaths = new Set(bundledQuestionExtensions.map((extension) => extension.path));
	return {
		...base,
		extensions: [
			...bundledQuestionExtensions,
			...base.extensions.filter((extension) => !bundledExtensionPaths.has(extension.path)),
		],
		errors: base.errors.filter((error) => !isBundledQuestionConflict(error, bundledExtensionPaths)),
	};
}

function extensionEntryExists(extensionPath: string): boolean {
	return existsSync(join(extensionPath, "index.ts")) || existsSync(join(extensionPath, "index.js"));
}

function extensionSymlinkType(): "dir" | "junction" {
	return process.platform === "win32" ? "junction" : "dir";
}

async function pathsReferToSameEntry(leftPath: string, rightPath: string): Promise<boolean> {
	try {
		const [leftRealPath, rightRealPath] = await Promise.all([realpath(leftPath), realpath(rightPath)]);
		return normalizePathForCompare(leftRealPath) === normalizePathForCompare(rightRealPath);
	} catch {
		return normalizePathForCompare(resolve(leftPath)) === normalizePathForCompare(resolve(rightPath));
	}
}

function normalizePathForCompare(pathValue: string): string {
	const normalized = resolve(pathValue);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isBundledQuestionExtension(extension: LoadExtensionsResult["extensions"][number], questionExtensionPath: string): boolean {
	return extension.tools.has(BUNDLED_QUESTION_EXTENSION_NAME) && pathIsInside(extension.resolvedPath, questionExtensionPath);
}

function pathIsInside(candidatePath: string, parentPath: string): boolean {
	const relativePath = relative(resolve(parentPath), resolve(candidatePath));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isBundledQuestionConflict(error: LoadExtensionsResult["errors"][number], bundledExtensionPaths: Set<string>): boolean {
	if (!error.error.startsWith(`Tool "${BUNDLED_QUESTION_EXTENSION_NAME}" conflicts with `)) return false;
	for (const bundledExtensionPath of bundledExtensionPaths) {
		if (error.path === bundledExtensionPath || error.error.endsWith(bundledExtensionPath)) return true;
	}
	return false;
}

export type CreatePixRuntimeOptions = {
	eventBus?: EventBus;
};

type RuntimeSessionManagerModelState = Pick<SessionManager, "getEntries" | "getBranch">;

export function resolvePixRuntimeModelRef(
	options: Pick<AppOptions, "modelRef">,
	sessionManager: RuntimeSessionManagerModelState,
	config: PixConfig = loadPixConfig(),
): string | undefined {
	if (options.modelRef) return options.modelRef;
	const existingEntryCount = sessionManager.getEntries().length;
	if (existingEntryCount > 0) return resolveSessionModelRefFromTail(sessionManager.getBranch());
	return resolveDefaultModelRef(config);
}

export function resolveSessionModelRefFromTail(entries: readonly SessionEntry[]): string | undefined {
	let modelRef: string | undefined;
	let thinkingLevel: string | undefined;
	for (let index = entries.length - 1; index >= 0 && (modelRef === undefined || thinkingLevel === undefined); index--) {
		const entry = entries[index];
		if (!entry) continue;
		if (thinkingLevel === undefined && entry.type === "thinking_level_change" && isThinkingLevel(entry.thinkingLevel)) {
			thinkingLevel = entry.thinkingLevel;
		}
		if (modelRef !== undefined) continue;
		if (entry.type === "model_change") {
			modelRef = `${entry.provider}/${entry.modelId}`;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			modelRef = `${entry.message.provider}/${entry.message.model}`;
		}
	}
	if (!modelRef) return undefined;
	return thinkingLevel ? `${modelRef}:${thinkingLevel}` : modelRef;
}

export async function createPixRuntime(options: AppOptions, runtimeOptions: CreatePixRuntimeOptions = {}): Promise<AgentSessionRuntime> {
	const agentDir = getAgentDir();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const effectiveModelRef = resolvePixRuntimeModelRef(options, sessionManager);
		const parsedModel = effectiveModelRef ? parseModelRef(effectiveModelRef) : undefined;
		await ensureBundledSkillsInstalled();
		await ensurePiToolsSuiteExtensionInstalled({ agentDir });
		const bundledExtensionPaths = getBundledExtensionPaths();
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				...(runtimeOptions.eventBus === undefined ? {} : { eventBus: runtimeOptions.eventBus }),
				...(bundledExtensionPaths.length === 0 ? {} : {
					additionalExtensionPaths: bundledExtensionPaths,
					extensionsOverride: prioritizeBundledQuestionExtension,
				}),
			},
		});
		services.modelRegistry.refresh();
		const model = parsedModel ? services.modelRegistry.find(parsedModel.provider, parsedModel.modelId) : undefined;
		if (parsedModel && !model) {
			throw new Error(`Model not found: ${parsedModel.provider}/${parsedModel.modelId}`);
		}
		const enabledModelRefs = services.settingsManager.getEnabledModels();
		const favoriteModelRefs = enabledModelRefs && enabledModelRefs.length > 0 ? enabledModelRefs : PI_FAVORITE_MODEL_REFS;
		const scopedModels = favoriteModelRefs.flatMap((modelRef): ScopedSessionModel[] => {
			const scoped = parseScopedModelRef(modelRef);
			if (!scoped) return [];

			const scopedModel = services.modelRegistry.find(scoped.provider, scoped.modelId) as SessionModel | undefined;
			if (!scopedModel) return [];

			return [
				{
					model: scopedModel,
					...(scoped.thinkingLevel === undefined ? {} : { thinkingLevel: scoped.thinkingLevel }),
				},
			];
		});

		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
				...(model === undefined ? {} : { model }),
				...(parsedModel?.thinkingLevel === undefined ? {} : { thinkingLevel: parsedModel.thinkingLevel }),
				...(scopedModels.length === 0 ? {} : { scopedModels }),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	return await createAgentSessionRuntime(createRuntime, {
		cwd: options.cwd,
		agentDir,
		sessionManager: options.noSession
			? SessionManager.inMemory(options.cwd)
			: options.sessionPath
				? SessionManager.open(options.sessionPath, undefined, options.cwd)
			: SessionManager.create(options.cwd),
	});
}
