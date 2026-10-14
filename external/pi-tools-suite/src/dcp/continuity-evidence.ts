import type { ToolRecord } from "./state.js";

export function recordDetails(record: ToolRecord): Record<string, unknown> {
	const value = record.outputDetails;
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function boundedText(value: string, limit = 2_048): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated; recover source before acting]`;
}

export function errorEvidence(output: string): string | undefined {
	const lines = output.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
	const errors = lines.filter((line) => /\b(error|failed?|failure|exception|denied|not found|cannot|unable|incomplete|unknown|timeout|aborted|pending)\b/i.test(line));
	const selected = [...new Set([...errors, ...lines.slice(-6)])];
	return selected.length ? boundedText(selected.join("\n")) : undefined;
}

export function failureDiagnostics(output: string): string | undefined {
	const lines = output.split(/\r?\n/).filter((line) => /\b(error|failed|failure|exception|denied|cannot|unable|incomplete|timeout|aborted)\b/i.test(line));
	return lines.length ? boundedText(lines.join("\n")) : undefined;
}

/** References are evidence, never instructions. No artifact reads or new effects. */
export function evidenceReferences(record: ToolRecord): string[] {
	const values = new Set<string>();
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || depth > 4) return;
		for (const [key, child] of Object.entries(value)) {
			if (/^(id|.*Id|.*ID|.*_id|status|outcome|log(Path|File)?|runDir|resultMd|revision|commit|gitSha|codeVersion|url|path)$/i.test(key) &&
				(typeof child === "string" || typeof child === "number")) values.add(`${key}=${child}`);
			else if (typeof child === "object") visit(child, depth + 1);
		}
	};
	visit(record.outputDetails, 0);
	visit(record.inputArgs, 0);
	// Extract facts, not whole lines: a JSON/codemode result can put an entire
	// transcript on the same line as one log path or operation ID.
	const output = record.outputText ?? "";
	const reference = /\b(?:id|(?:operation|request|transaction|job|agent)[_ -]?id|status|outcome|TEST_RESULT|log(?:Path|File)?|runDir|resultMd|revision|commit|codeVersion)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi;
	for (const match of output.matchAll(reference)) values.add(match[0]);
	for (const match of output.matchAll(/\.pi\/(?:artifacts|subagents)\/[^\s"'<>}\],;]+/g)) values.add(match[0]);
	return [...values];
}

export function changedFiles(record: ToolRecord): string[] {
	const files = new Set<string>();
	const details = recordDetails(record);
	if (Array.isArray(details.changedFiles)) for (const path of details.changedFiles) {
		if (typeof path === "string") files.add(path);
	}
	for (const key of ["path", "file_path", "filePath"]) {
		if (typeof record.inputArgs[key] === "string") files.add(record.inputArgs[key] as string);
	}
	for (const value of [record.inputArgs.input, record.inputArgs.patch, record.outputText]) {
		if (typeof value !== "string") continue;
		for (const line of value.split(/\r?\n/)) {
			const match = /^(?:\*\*\* (?:Add|Update|Delete|Move to) File:|\*\*\* Move to:|[AMD])\s+(.+)$/.exec(line);
			if (match) files.add(match[1]!);
		}
	}
	return [...files];
}
