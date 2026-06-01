export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isNumberArray(value: unknown): value is number[] {
	return Array.isArray(value) && value.every((item) => typeof item === "number");
}

