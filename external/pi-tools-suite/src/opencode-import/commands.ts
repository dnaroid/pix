import type { OpencodeImportOptions, OpencodeImportResult, OpencodeProviderImportResult } from "./importer";

function tokenizeArgs(args: string): string[] {
	return args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^("|')|("|')$/g, "")) ?? [];
}

export function parseOpencodeImportCommandArgs(args: string): OpencodeImportOptions {
	const tokens = tokenizeArgs(args);
	const parsed: OpencodeImportOptions = {};
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--force" || token === "-f") {
			parsed.overwrite = true;
		} else if ((token === "--path" || token === "--opencode-auth-path") && tokens[i + 1]) {
			parsed.sourcePath = tokens[++i];
		} else if (token === "--auth-path" && tokens[i + 1]) {
			parsed.authPath = tokens[++i];
		} else if (token === "--antigravity-path" && tokens[i + 1]) {
			parsed.antigravitySourcePath = tokens[++i];
		} else if (token === "--skip-auth-json") {
			parsed.skipAuthJson = true;
		} else if (token === "--skip-antigravity") {
			parsed.skipAntigravity = true;
		} else if ((token === "--antigravity-index" || token === "--antigravity-account-index") && tokens[i + 1]) {
			const index = Number(tokens[++i]);
			if (Number.isInteger(index)) parsed.antigravityAccountIndex = index;
		} else if (token === "--antigravity-email" && tokens[i + 1]) {
			parsed.antigravityEmail = tokens[++i];
		} else if (!token.startsWith("-") && !parsed.sourcePath) {
			parsed.sourcePath = token;
		}
	}
	return parsed;
}

function statusText(result: OpencodeProviderImportResult): string {
	switch (result.status) {
		case "imported":
			return `imported ${result.sourceProvider} → ${result.targetProvider}`;
		case "already-imported":
			return `already imported ${result.targetProvider}`;
		case "auth-exists-use-force":
			return `skipped ${result.targetProvider}: already exists; use --force`;
		case "target-set-from-other-source":
			return `skipped ${result.sourceProvider}: ${result.targetProvider} was already filled from another opencode entry`;
		case "invalid-source":
			return `skipped ${result.sourceProvider}: missing usable token/key`;
		case "source-missing":
			return `missing ${result.sourceProvider}`;
	}
}

function antigravityText(result: OpencodeImportResult): string | undefined {
	const antigravity = result.antigravity;
	if (!antigravity) return undefined;
	const account = antigravity.email ? ` ${antigravity.email}` : "";
	const position = typeof antigravity.accountIndex === "number" && typeof antigravity.accountCount === "number" ? ` (${antigravity.accountIndex + 1}/${antigravity.accountCount})` : "";
	if (antigravity.imported) {
		return `Antigravity: imported${account}${position}${antigravity.overwroteExisting ? " and overwrote existing auth" : ""}`;
	}
	if (antigravity.reason === "auth-exists-use-force") return "Antigravity: skipped existing auth; use --force";
	if (antigravity.reason === "already-imported") return `Antigravity: already imported${account}${position}`;
	return `Antigravity: skipped (${antigravity.reason ?? "unknown"})`;
}

export function formatOpencodeImportResult(result: OpencodeImportResult): string {
	const providerLines = result.providers
		.filter((provider) => provider.status !== "source-missing")
		.map((provider) => `- ${provider.label}: ${statusText(provider)}`);
	const missingCount = result.providers.filter((provider) => provider.status === "source-missing").length;
	const antigravity = antigravityText(result);
	if (antigravity) providerLines.push(`- ${antigravity}`);

	if (providerLines.length === 0) {
		return `No opencode credentials were imported. Checked ${result.sourcePath}${result.antigravitySourcePath ? ` and ${result.antigravitySourcePath}` : ""}.`;
	}

	const suffix = missingCount > 0 ? `\nMissing ${missingCount} known opencode provider entr${missingCount === 1 ? "y" : "ies"}.` : "";
	return `Opencode import wrote to ${result.authPath}:\n${providerLines.join("\n")}${suffix}`;
}

export function notificationLevel(result: OpencodeImportResult): "info" | "warn" | "error" {
	if (result.wroteAuth) return "info";
	if (result.providers.some((provider) => provider.status === "auth-exists-use-force") || result.antigravity?.reason === "auth-exists-use-force") return "warn";
	return "error";
}
