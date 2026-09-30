export const TODO_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type TodoThinkingLevel = (typeof TODO_THINKING_LEVELS)[number];
export type TodoThinkingRange = { min: TodoThinkingLevel; max: TodoThinkingLevel };
export type TodoThinkingPolicy = TodoThinkingRange;

export function isTodoThinkingLevel(value: unknown): value is TodoThinkingLevel {
	return TODO_THINKING_LEVELS.includes(value as TodoThinkingLevel);
}

export function isTodoThinkingPolicy(value: unknown): value is TodoThinkingPolicy {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const range = value as TodoThinkingRange;
	return isTodoThinkingLevel(range.min) && isTodoThinkingLevel(range.max)
		&& TODO_THINKING_LEVELS.indexOf(range.min) <= TODO_THINKING_LEVELS.indexOf(range.max);
}

/** Never round past a range's ceiling if the model offers a level below it. */
export function clampTodoThinkingRange(
	available: readonly TodoThinkingLevel[],
	requested: TodoThinkingLevel,
	range: TodoThinkingRange,
): TodoThinkingLevel {
	const rank = (level: TodoThinkingLevel) => TODO_THINKING_LEVELS.indexOf(level);
	const within = available.filter((level) => rank(level) >= rank(range.min) && rank(level) <= rank(range.max));
	if (within.length === 0) {
		// A sparse/non-reasoning model may have no level in the range. Favor the
		// cost ceiling over the floor, or its lowest level if the ceiling is impossible.
		const belowCeiling = available.filter((level) => rank(level) <= rank(range.max));
		return belowCeiling[belowCeiling.length - 1] ?? available[0] ?? "off";
	}
	const target = Math.max(rank(range.min), Math.min(rank(range.max), rank(requested)));
	return within.find((level) => rank(level) >= target) ?? within[within.length - 1]!;
}
