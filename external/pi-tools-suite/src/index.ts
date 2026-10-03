import { loadPiToolsSuiteConfig } from "./config";
import { publishContextInventoryState } from "./context-inventory";
import { isPixOwnedHost } from "./lib/native-pi-tui.js";
import { PI_TOOLS_SUITE_MODULE_CATALOG, type PiToolsSuiteModuleCatalogEntry } from "./module-catalog.js";
import { loadSuiteModules } from "./module-loader.js";
import { registerProviderWebSearchGuard } from "./provider-web-search-guard.js";
import { publishStartupModuleList } from "./startup-section";

type ExtensionAPI = any;

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

type ExtensionModule = {
	default: ExtensionFactory;
};

export type RegisteredPiToolsSuiteModule = PiToolsSuiteModuleCatalogEntry & {
	load: () => Promise<ExtensionModule>;
};

/**
 * Runtime registration is derived from the metadata-only catalog so config,
 * Desktop Settings, defaults, ordering, and runtime loading share one module list.
 * Module entrypoints follow the suite convention src/<module-name>/index.ts.
 */
export const MODULES: readonly RegisteredPiToolsSuiteModule[] = PI_TOOLS_SUITE_MODULE_CATALOG.map((module) => ({
	...module,
	load: () => import(`./${module.name}/index`) as Promise<ExtensionModule>,
}));

export default async function piToolsSuite(pi: ExtensionAPI) {
	const config = loadPiToolsSuiteConfig(MODULES.map((module) => module.name));
	const disabledModules = new Set(config.enabled ? config.disabledModules : MODULES.map((module) => module.name));

	const { loaded: loadedModuleNames, failures } = await loadSuiteModules(pi, MODULES.filter((module) =>
		!disabledModules.has(module.name) && !(module.cleanPiOnly && isPixOwnedHost())));
	for (const failure of failures) {
		console.warn(`Skipped pi-tools-suite module ${failure.name}: ${failure.error}`);
	}
	if (failures.length > 0) {
		pi.on("session_start", (_event: unknown, ctx: any) => {
			ctx.ui.notify(`pi-tools-suite: skipped broken modules: ${failures.map((failure) => failure.name).join(", ")}. See startup log for details.`, "warning");
		});
	}
	registerProviderWebSearchGuard(pi);

	// Register last so the snapshot observes model-specific tool selection after
	// every module's session/model hooks have run.
	pi.on("session_start", (event: any, ctx: any) => publishContextInventoryState(pi, ctx, event?.reason));
	pi.on("model_select", (_event: unknown, ctx: any) => publishContextInventoryState(pi, ctx, "model_select"));

	await publishStartupModuleList(loadedModuleNames);
}
