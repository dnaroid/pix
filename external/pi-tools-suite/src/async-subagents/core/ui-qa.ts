import { fileURLToPath } from "node:url";

/** Canonical UI-QA role plus the pre-rename compatibility alias. */
export const UI_QA_TYPE = "ui-qa";
export const LEGACY_BROWSER_QA_TYPE = "browser-qa";

export function isUiQaType(value: string | undefined): boolean {
	return value === UI_QA_TYPE || value === LEGACY_BROWSER_QA_TYPE;
}

/** Non-secret, launcher-owned path supplied only to UI-QA children. */
export const BROWSER_QA_RUNNER_ENV = "PI_BROWSER_QA_RUNNER";
export const UI_QA_RUNNER_ENV = "PI_UI_QA_RUNNER";

/** Resolve against the installed package, never the delegated project's cwd. */
export function getBrowserQaRunnerPath(): string {
	return fileURLToPath(new URL("../agents/ui-qa/browser/scripts/browser-qa-runner.mjs", import.meta.url));
}

/** Resolve the capability-first UI-QA runner against the installed package. */
export function getUiQaRunnerPath(): string {
	return fileURLToPath(new URL("../agents/ui-qa/scripts/ui-qa-runner.mjs", import.meta.url));
}
