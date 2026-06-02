import { loadPiToolsSuiteConfig } from "./config";
import { publishStartupModuleList } from "./startup-section";

type ExtensionAPI = any;

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

type ExtensionModule = {
	default: ExtensionFactory;
};

const MODULES: Array<{ name: string; load: () => Promise<ExtensionModule> }> = [
	{ name: "ast-grep", load: () => import("./ast-grep/index") },
	{ name: "async-subagents", load: () => import("./async-subagents/index") },
	{ name: "terminal-bell", load: () => import("./terminal-bell/index") },
	{ name: "lsp", load: () => import("./lsp/index") },
	{ name: "repo-discovery", load: () => import("./repo-discovery/index") },
	{ name: "antigravity-auth", load: () => import("./antigravity-auth/index") },
	{ name: "todo", load: () => import("./todo/index") },
	{ name: "model-tools", load: () => import("./model-tools/index") },
	{ name: "usage", load: () => import("./usage/index") },
	{ name: "web-search", load: () => import("./web-search/index") },
	{ name: "dcp", load: () => import("./dcp/index") },
	{ name: "prompt-commands", load: () => import("./prompt-commands/index") },
];

export default async function piToolsSuite(pi: ExtensionAPI) {
	const loadedModuleNames: string[] = [];
	const config = loadPiToolsSuiteConfig(MODULES.map((module) => module.name));
	const disabledModules = new Set(config.enabled ? config.disabledModules : MODULES.map((module) => module.name));

	for (const module of MODULES) {
		if (disabledModules.has(module.name)) continue;

		try {
			const loaded = await module.load();
			await loaded.default(pi);
			loadedModuleNames.push(module.name);
		} catch (error) {
			const message = error instanceof Error ? error.stack ?? error.message : String(error);
			throw new Error(`Failed to load pi-tools-suite module ${module.name}: ${message}`);
		}
	}

	await publishStartupModuleList(loadedModuleNames);
}
