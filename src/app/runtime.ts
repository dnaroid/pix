import { existsSync } from "node:fs";
import { access, cp, lstat, mkdir, readlink, realpath, rm, symlink } from "node:fs/promises";
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
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	type LoadExtensionsResult,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadPixConfig, resolveDefaultModelRef, type PixConfig } from "../config.js";
import { PI_FAVORITE_MODEL_REFS } from "./constants.js";
import { isThinkingLevel, parseModelRef, parseScopedModelRef } from "./model/model-ref.js";
import { openLazySessionManager } from "./session/lazy-session-manager.js";
import type { AppOptions, ScopedSessionModel, SessionModel, ThinkingLevel } from "./types.js";

const BUNDLED_QUESTION_EXTENSION_NAME = "question";
const PI_TOOLS_SUITE_EXTENSION_NAME = "pi-tools-suite";
const BUNDLED_EXTENSIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"bundled-extensions",
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

	if (!(await extensionEntryExistsAsync(sourcePath))) {
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

export async function getBundledExtensionPathsAsync(): Promise<string[]> {
	const paths = await Promise.all([
		bundledQuestionExtensionPath(),
		bundledSessionTitleExtensionPath(),
		bundledTerminalBellExtensionPath(),
	].map(async (extensionPath) => await extensionEntryExistsAsync(extensionPath) ? extensionPath : undefined));
	return paths.filter((path): path is string => path !== undefined);
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

async function extensionEntryExistsAsync(extensionPath: string): Promise<boolean> {
	try {
		await access(join(extensionPath, "index.ts"));
		return true;
	} catch {
		try {
			await access(join(extensionPath, "index.js"));
			return true;
		} catch {
			return false;
		}
	}
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
	config?: PixConfig;
	reuseServicesFrom?: AgentSessionRuntime;
};

const bundledSkillsInstallPromises = new Map<string, Promise<BundledSkillsInstallResult>>();
const piToolsSuiteInstallPromises = new Map<string, Promise<PiToolsSuiteInstallResult>>();

async function ensureBundledSkillsInstalledOnce(options: BundledSkillsInstallOptions = {}): Promise<BundledSkillsInstallResult> {
	const targetPath = resolve(options.targetPath ?? bundledSkillsInstallPath(options.homeDir));
	const existing = bundledSkillsInstallPromises.get(targetPath);
	if (existing) return await existing;

	const pending = ensureBundledSkillsInstalled(options).catch((error) => {
		bundledSkillsInstallPromises.delete(targetPath);
		throw error;
	});
	bundledSkillsInstallPromises.set(targetPath, pending);
	return await pending;
}

async function ensurePiToolsSuiteExtensionInstalledOnce(options: PiToolsSuiteInstallOptions = {}): Promise<PiToolsSuiteInstallResult> {
	const targetPath = resolve(options.targetPath ?? piToolsSuiteExtensionInstallPath(options.agentDir));
	const existing = piToolsSuiteInstallPromises.get(targetPath);
	if (existing) return await existing;

	const pending = ensurePiToolsSuiteExtensionInstalled(options).catch((error) => {
		piToolsSuiteInstallPromises.delete(targetPath);
		throw error;
	});
	piToolsSuiteInstallPromises.set(targetPath, pending);
	return await pending;
}

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

export function resolvePixRuntimeInitialThinkingLevel(
	options: Pick<AppOptions, "modelRef">,
	sessionManager: RuntimeSessionManagerModelState,
	config: PixConfig,
): ThinkingLevel | undefined {
	const effectiveModelRef = resolvePixRuntimeModelRef(options, sessionManager, config);
	const parsedModel = effectiveModelRef ? parseModelRef(effectiveModelRef) : undefined;
	return parsedModel?.thinkingLevel;
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
	const reusableServices = reusableRuntimeServices(runtimeOptions.reuseServicesFrom, options.cwd, agentDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const config = runtimeOptions.config ?? loadPixConfig(cwd);
		const effectiveModelRef = resolvePixRuntimeModelRef(options, sessionManager, config);
		const parsedModel = effectiveModelRef ? parseModelRef(effectiveModelRef) : undefined;
		const initialThinkingLevel = resolvePixRuntimeInitialThinkingLevel(options, sessionManager, config);
		// Only reuse services for the initial session. Session replacements
		// (switchSession/newSession/fork) must get fresh services so extensions
		// are re-loaded with a fresh pi — otherwise handlers capture the old,
		// invalidated pi and throw stale-ctx errors on the next session_start.
		const isInitialSession = !sessionStartEvent || sessionStartEvent.reason === "startup";
		const services = isInitialSession && reusableServices && sameRuntimeServiceTarget(reusableServices, cwd, agentDir)
			? reusableServices
			: await createPixRuntimeServices({
				cwd,
				agentDir,
				config,
				...(runtimeOptions.eventBus === undefined ? {} : { eventBus: runtimeOptions.eventBus }),
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

		const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
				...(model === undefined ? {} : { model }),
				...(initialThinkingLevel === undefined ? {} : { thinkingLevel: initialThinkingLevel }),
				...(scopedModels.length === 0 ? {} : { scopedModels }),
		});
		return {
			...created,
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
				? await openLazySessionManager(options.sessionPath, { cwdOverride: options.cwd })
				: SessionManager.create(options.cwd),
	});
}

async function createPixRuntimeServices(options: {
	cwd: string;
	agentDir: string;
	eventBus?: EventBus;
	config: PixConfig;
}): Promise<AgentSessionServices> {
	await ensureBundledSkillsInstalledOnce();
	await ensurePiToolsSuiteExtensionInstalledOnce({ agentDir: options.agentDir });
	const bundledExtensionPaths = await getBundledExtensionPathsAsync();
	return await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: options.agentDir,
		resourceLoaderOptions: {
			...(options.config.ignoreContextFiles ? { noContextFiles: true } : {}),
			...(options.eventBus === undefined ? {} : { eventBus: options.eventBus }),
			...(bundledExtensionPaths.length === 0 ? {} : {
				additionalExtensionPaths: bundledExtensionPaths,
				extensionsOverride: prioritizeBundledQuestionExtension,
			}),
		},
	});
}

function reusableRuntimeServices(runtime: AgentSessionRuntime | undefined, cwd: string, agentDir: string): AgentSessionServices | undefined {
	const services = runtime?.services;
	return services && sameRuntimeServiceTarget(services, cwd, agentDir) ? services : undefined;
}

function sameRuntimeServiceTarget(services: AgentSessionServices, cwd: string, agentDir: string): boolean {
	return normalizePathForCompare(services.cwd) === normalizePathForCompare(cwd)
		&& normalizePathForCompare(services.agentDir) === normalizePathForCompare(agentDir);
}
