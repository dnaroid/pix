const privateKey = /^(?:authorization|cookie|password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|prompt|messages?|content|body|input|output|args|arguments|response|request|headers)$/i;

export function redactLogText(text: string): string {
	return text.slice(0, 8192)
		.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[REDACTED]")
		.replace(/\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]+/g, "[REDACTED]")
		.replace(/((?:api[-_]?key|password|secret|token)\s*[=:]\s*)[^\s"',;&]+/gi, "$1[REDACTED]")
		.replace(/https?:\/\/[^\s"<>]+/gi, "[URL]");
}

/** Bounded, cycle-safe snapshots; never traverse arbitrary getters/toJSON hooks. */
export function sanitizeLogValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") return redactLogText(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return String(value);
	if (typeof value !== "object") return undefined;
	if (depth >= 6 || seen.has(value)) return "[TRUNCATED]";
	seen.add(value);
	try {
		if (value instanceof Error) return { name: redactLogText(value.name), message: redactLogText(value.message), stack: redactLogText(value.stack ?? "") };
		if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitizeLogValue(item, depth + 1, seen));
		const result: Record<string, unknown> = {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value)).slice(0, 40)) {
			result[key] = privateKey.test(key) ? "[REDACTED]" : "value" in descriptor ? sanitizeLogValue(descriptor.value, depth + 1, seen) : "[GETTER]";
		}
		return result;
	} catch { return "[UNSERIALIZABLE]"; }
}
