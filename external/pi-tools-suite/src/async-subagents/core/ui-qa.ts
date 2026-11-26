import { fileURLToPath } from "node:url";

/** Canonical UI-QA role. */
export const UI_QA_TYPE = "ui-qa";

export function isUiQaType(value: string | undefined): boolean {
	return value === UI_QA_TYPE;
}

/** Non-secret, launcher-owned path supplied only to UI-QA children. */
export const UI_QA_RUNNER_ENV = "PI_UI_QA_RUNNER";

/** Resolve the capability-first UI-QA runner against the installed package. */
export function getUiQaRunnerPath(): string {
	return fileURLToPath(new URL("../agents/ui-qa/scripts/ui-qa-runner.mjs", import.meta.url));
}
