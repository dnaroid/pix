export function stringifyUnknown(value: unknown): string {
	if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
