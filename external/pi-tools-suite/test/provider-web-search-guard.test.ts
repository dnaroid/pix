import { expect, test } from "bun:test";
import { registerProviderWebSearchGuard } from "../src/provider-web-search-guard.js";

const SEARCH = "pi_claude_code_provider_web_search";

test("provider search is hidden even when registered after session_start, and cannot execute", () => {
	const handlers = new Map<string, Array<(event: any) => unknown>>();
	let active = ["read", "web_search"];
	let changes = 0;
	const pi = {
		on(name: string, handler: (event: any) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getActiveTools: () => active,
		setActiveTools(tools: string[]) { active = tools; changes++; },
	};
	const emit = (name: string, event: unknown = {}) => handlers.get(name)?.map((handler) => handler(event));
	registerProviderWebSearchGuard(pi as any);

	emit("session_start");
	active.push(SEARCH); // provider's later session_start handler
	emit("before_agent_start");
	expect(active).toEqual(["read", "web_search"]);
	expect(changes).toBe(1);
	emit("before_agent_start");
	expect(changes).toBe(1); // no unnecessary tool-profile churn

	active.push(SEARCH);
	emit("model_select");
	expect(active).toEqual(["read", "web_search"]);
	expect(emit("tool_call", { toolName: SEARCH })?.[0]).toMatchObject({ block: true });
	expect(emit("tool_call", { toolName: "web_search" })?.[0]).toBeUndefined();
});
