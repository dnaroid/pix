import type { AntigravityAddAccountResult, AntigravityStatusDetails, OpencodeAntigravityImportResult } from "./types";

function tokenizeArgs(args: string): string[] {
	return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^("|')|("|')$/g, "")) ?? [];
}

export function parseImportCommandArgs(args: string): { sourcePath?: string; overwrite?: boolean; accountIndex?: number; email?: string } {
	const tokens = tokenizeArgs(args);
	const parsed: { sourcePath?: string; overwrite?: boolean; accountIndex?: number; email?: string } = {};
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--force" || token === "-f") {
			parsed.overwrite = true;
		} else if (token === "--path" && tokens[i + 1]) {
			parsed.sourcePath = tokens[++i];
		} else if ((token === "--index" || token === "--account-index") && tokens[i + 1]) {
			const index = Number(tokens[++i]);
			if (Number.isInteger(index)) parsed.accountIndex = index;
		} else if (token === "--email" && tokens[i + 1]) {
			parsed.email = tokens[++i];
		} else if (!token.startsWith("-") && !parsed.sourcePath) {
			parsed.sourcePath = token;
		}
	}
	return parsed;
}

export function formatImportResult(result: OpencodeAntigravityImportResult): string {
	const account = result.email ? `${result.email} ` : "";
	const position = typeof result.accountIndex === "number" && result.accountCount ? `(account ${result.accountIndex}/${result.accountCount - 1}) ` : "";
	if (result.imported) {
		return `Imported ${account}${position}from ${result.sourcePath} into ${result.authPath}. Token will refresh on first use.${result.overwroteExisting ? " Existing Antigravity auth was overwritten." : ""}`;
	}
	if (result.reason === "auth-exists-use-force") {
		return `Antigravity auth already exists in ${result.authPath}; run /antigravity-import --force to overwrite it with ${account}${position}from ${result.sourcePath}.`;
	}
	if (result.reason === "already-imported") {
		return `Antigravity auth is already imported from ${result.sourcePath} (${account}${position.trim()}).`;
	}
	return `Could not import Antigravity auth from ${result.sourcePath}: ${result.reason ?? "unknown error"}.`;
}

export function parseAddAccountCommandArgs(args: string): { activate?: boolean; email?: string } {
	const tokens = tokenizeArgs(args);
	const parsed: { activate?: boolean; email?: string } = {};
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--activate" || token === "-a") {
			parsed.activate = true;
		} else if (token === "--email" && tokens[i + 1]) {
			parsed.email = tokens[++i];
		}
	}
	return parsed;
}

export function formatAddAccountResult(result: AntigravityAddAccountResult): string {
	const account = result.email ?? "unknown account";
	const action = result.updatedExisting ? "Updated" : "Added";
	const active = result.activated ? " and activated" : "";
	const project = result.projectId ? ` project ${result.projectId}` : "";
	return `${action} Antigravity account ${account}${active} (${result.accountIndex + 1}/${result.accountCount})${project}. Saved to ${result.authPath}.`;
}

function formatAccountPosition(index?: number, count?: number): string {
	return typeof index === "number" && typeof count === "number" ? `${index + 1}/${count}` : "unknown";
}

export function formatAntigravityStatus(details: AntigravityStatusDetails): string {
	const account = details.email ?? "unknown account";
	const position = formatAccountPosition(details.accountIndex, details.accountCount);
	const project = details.projectId ? ` project ${details.projectId}` : "";
	if (details.kind === "switch") {
		return `Antigravity switched to ${account} (${position})`;
	}
	const expiry = details.expires && details.expires > 0 ? ` token expires ${new Date(details.expires).toLocaleTimeString()}` : " token will refresh on next use";
	return `Antigravity current account: ${account} (${position})${project};${expiry}.`;
}
