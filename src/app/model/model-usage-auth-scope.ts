import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// A query's profile must survive awaits without changing process-wide environment.
const authPaths = new AsyncLocalStorage<string>();

export function modelUsageAuthPath(): string {
	if (process.env.NODE_ENV === "test" && process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH) return process.env.PI_TOOLS_SUITE_TEST_AUTH_PATH;
	return authPaths.getStore() ?? join(getAgentDir(), "auth.json");
}

export function withModelUsageAuthScope<T>(agentDir: string | undefined, operation: () => T): T {
	return agentDir ? authPaths.run(join(agentDir, "auth.json"), operation) : operation();
}
