import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import dcpModule from "./index.js";

/** Normal DCP lifecycle/configuration, without interactive DCP commands. */
export default async function subagentDcp(pi: ExtensionAPI, dependencies: Parameters<typeof dcpModule>[1] = {}): Promise<void> {
	await dcpModule({ ...pi, registerCommand: () => {} }, dependencies);
	const enableCompress = () => {
		try {
			if (!pi.getAllTools().some((tool) => tool.name === "compress")) return;
			const active = pi.getActiveTools();
			if (!active.includes("compress")) pi.setActiveTools([...active, "compress"]);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	};
	pi.on("session_start", enableCompress);
	pi.on("model_select", enableCompress);
}
