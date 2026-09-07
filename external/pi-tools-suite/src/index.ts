import { loadPiToolsSuiteConfig } from "./config";
import { publishStartupModuleList } from "./startup-section";

type ExtensionAPI = any;

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

type ExtensionModule = {
	default: ExtensionFactory;
};

export const MODULES: Array<{ name: string; load: () => Promise<ExtensionModule> }> = [
	{ name: "coding-discipline", load: () => import("./coding-discipline/index") },
	{ name: "ast-grep", load: () => import("./ast-grep/index") },
	{ name: "async-subagents", load: () => import("./async-subagents/index") },
	{ name: "lsp", load: () => import("./lsp/index") },
	{ name: "comment-checker", load: () => import("./comment-checker/index") },
	{ name: "session-name", load: () => import("./session-name/index") },
	{ name: "session-recovery", load: () => import("./session-recovery/index") },
	{ name: "repo-discovery", load: () => import("./repo-discovery/index") },
	{ name: "antigravity-auth", load: () => import("./antigravity-auth/index") },
	{ name: "opencode-import", load: () => import("./opencode-import/index") },
	{ name: "todo", load: () => import("./todo/index") },
	{ name: "model-tools", load: () => import("./model-tools/index") },
	{ name: "usage", load: () => import("./usage/index") },
	{ name: "web-search", load: () => import("./web-search/index") },
	// Observe-only Context Gateway currently runs after result enrichers. P01-R
	// keeps this independent result chain; a coordinator is conditional future
	// enforce work only if a concrete ordering conflict is proven.
	{ name: "context-gateway", load: () => import("./context-gateway/index") },
	// Explicit opt-in, non-store cleanup. Keep after Gateway observe so passive
	// telemetry measures the original boundary, and before downstream result
	// observers. This ordering does not depend on any particular DCP persistence
	// design; DCP is scheduled for a separate redesign.
	{ name: "truncation-metadata-normalizer", load: () => import("./truncation-metadata-normalizer/index") },
	{ name: "dcp", load: () => import("./dcp/index") },
	{ name: "prompt-commands", load: () => import("./prompt-commands/index") },
	{ name: "skill-installer", load: () => import("./skill-installer/index") },
	// Secret firewall is intentionally opt-in. Keep it after payload-shaping modules.
	{ name: "credential-firewall", load: () => import("./credential-firewall/index") },
	// Keep this last: its before_provider_request handler is the final payload
	// sanitizer after DCP and any other provider-payload modifiers.
	{ name: "codex-reasoning-fix", load: () => import("./codex-reasoning-fix/index") },
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
