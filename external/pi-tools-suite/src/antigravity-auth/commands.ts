import type { AntigravityAddAccountResult, AntigravityStatusDetails } from "./types";

function tokenizeArgs(args: string): string[] {
	return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^("|')|("|')$/g, "")) ?? [];
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
