import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionServices,
	getAgentDir,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";

export interface DesktopDraftModelRuntimeOptions {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly additionalExtensionPaths?: readonly string[];
}

export interface DesktopDraftModelRuntimeHandle {
	readonly modelRuntime: ModelRuntime;
	dispose(): void;
}

export interface DesktopToolsSuiteExtensionOptions {
	readonly agentDir?: string;
	readonly bundledExtensionPath?: string;
}

/**
 * Prefer the agent's installed pi-tools-suite when present so Desktop matches
 * TUI extension precedence and never loads a second copy of the suite.
 */
export function desktopToolsSuiteExtensionPath(
	options: DesktopToolsSuiteExtensionOptions,
): string | undefined {
	if (!options.bundledExtensionPath) return undefined;
	const agentDir = options.agentDir ?? getAgentDir();
	const installedExtensionPath = join(agentDir, "extensions", "pi-tools-suite");
	return existsSync(installedExtensionPath) ? undefined : options.bundledExtensionPath;
}

/**
 * Build a workspace-scoped, sessionless model runtime for Desktop drafts.
 *
 * Loading services (rather than a bare ModelRuntime) is important: extensions
 * such as pi-tools-suite register their own providers while resources load.
 * The returned handle keeps that temporary extension runtime alive while the
 * caller inspects or streams through registered providers; dispose() then
 * invalidates it. No AgentSession or session file is created.
 */
export async function createDesktopDraftModelRuntime(
	options: DesktopDraftModelRuntimeOptions,
): Promise<DesktopDraftModelRuntimeHandle> {
	const agentDir = options.agentDir ?? getAgentDir();
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		// The normal Desktop draft catalog explicitly refreshes cache-only.
		// Auto routing may opt into a one-provider network refresh on demand.
		allowModelNetwork: true,
		refreshOnCreate: false,
	});
	const additionalExtensionPaths = [...(options.additionalExtensionPaths ?? [])];
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir,
		modelRuntime,
		resourceLoaderOptions: {
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			...(additionalExtensionPaths.length === 0 ? {} : { additionalExtensionPaths }),
		},
	});

	let disposed = false;
	return {
		modelRuntime: services.modelRuntime,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			services.resourceLoader.getExtensions().runtime.invalidate("Desktop draft model runtime completed");
		},
	};
}
