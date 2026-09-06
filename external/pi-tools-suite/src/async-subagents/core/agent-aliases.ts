import type { SubagentConfig } from "./config.js";

/** Compatibility only; do not advertise these as additional built-in roles. */
export const LEGACY_SUBAGENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	quick: "research",
	scan: "research",
	review: "research",
	deep: "research",
	docs: "implement",
	frontend: "implement",
	tests: "verify",
});

export function legacySubagentTarget(name: string): string | undefined {
	return Object.prototype.hasOwnProperty.call(LEGACY_SUBAGENT_TYPES, name)
		? LEGACY_SUBAGENT_TYPES[name]
		: undefined;
}

/** An explicitly configured/project-local name always wins over an alias. */
export function resolveSubagentTypeName(name: string, config: SubagentConfig): string {
	if (Object.prototype.hasOwnProperty.call(config.types, name)) return name;
	const target = legacySubagentTarget(name);
	return target && Object.prototype.hasOwnProperty.call(config.types, target) ? target : name;
}
