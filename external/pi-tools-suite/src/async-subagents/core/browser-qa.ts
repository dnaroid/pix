import { fileURLToPath } from "node:url";

/** Non-secret, launcher-owned path supplied only to browser-qa children. */
export const BROWSER_QA_RUNNER_ENV = "PI_BROWSER_QA_RUNNER";

/** Resolve against the installed package, never the delegated project's cwd. */
export function getBrowserQaRunnerPath(): string {
	return fileURLToPath(new URL("../agents/browser-qa/scripts/browser-qa-runner.mjs", import.meta.url));
}
