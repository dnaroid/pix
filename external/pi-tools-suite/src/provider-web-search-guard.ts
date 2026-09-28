import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "./context-usage.js";

const PROVIDER_WEB_SEARCH = "pi_claude_code_provider_web_search";

/** Keep the Claude subscription provider, but never offer its metered search tool. */
export function registerProviderWebSearchGuard(pi: ExtensionAPI): void {
	const removeSearch = () => {
		try {
			const active = pi.getActiveTools();
			if (active.includes(PROVIDER_WEB_SEARCH)) {
				pi.setActiveTools(active.filter((name) => name !== PROVIDER_WEB_SEARCH));
			}
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	};

	// The provider registers search during session_start, possibly after our own
	// handler. before_agent_start catches either extension load order.
	pi.on("session_start", removeSearch);
	pi.on("model_select", removeSearch);
	pi.on("before_agent_start", removeSearch);
	// A later extension or manual tool selection cannot execute it either.
	pi.on("tool_call", (event) => event.toolName === PROVIDER_WEB_SEARCH
		? { block: true, reason: `${PROVIDER_WEB_SEARCH} is disabled; use web_search instead` }
		: undefined);
}
