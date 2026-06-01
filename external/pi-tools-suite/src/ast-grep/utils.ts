import type { AstGrepParamsType } from "./types";

export function cleanPath(path: string): string {
	return path.trim();
}

export function normalizeNonNegativeInteger(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return value;
}

export function countLikelyMatches(output: string, params: AstGrepParamsType): number {
	const trimmed = output.trim();
	if (!trimmed) return 0;

	if (params.json) {
		try {
			const parsed = JSON.parse(trimmed);
			return Array.isArray(parsed) ? parsed.length : 0;
		} catch {
			const jsonLineCount = trimmed.split("\n").filter((line) => {
				try {
					JSON.parse(line);
					return true;
				} catch {
					return false;
				}
			}).length;
			if (jsonLineCount > 0) return jsonLineCount;
			// Fall through if ast-grep changed its JSON shape or output was truncated.
		}
	}

	if (params.updateAll) {
		const applied = trimmed.match(/Applied\s+(\d+)\s+changes?/i);
		if (applied) return Number(applied[1]);
	}

	if (params.rewrite) {
		return trimmed
			.split("\n")
			.filter((line) => line.includes("│-") || line.match(/^\s*[-+]\d+\s*│[+-]/)).length;
	}

	if (params.command === "scan") {
		return trimmed
			.split("\n")
			.filter((line) => /(?:^|:\d+:\d+:\s+)(?:error|warning|info|hint)\[[^\]]+\]:/i.test(line.trim()))
			.length;
	}

	return trimmed.split("\n").filter((line) => line.trim()).length;
}

export function shellQuoteForDisplay(args: string[]): string {
	return args
		.map((arg) => {
			if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
			return `'${arg.replace(/'/g, `'"'"'`)}'`;
		})
		.join(" ");
}
