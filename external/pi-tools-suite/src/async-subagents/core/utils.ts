export function isoNow(): string {
	return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
